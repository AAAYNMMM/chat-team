import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const port = Number(process.env.CHAT_TEAM_PORT || 32324);
const root = fileURLToPath(new URL('../public/', import.meta.url));
const broadcastHoldMs = clampInt(process.env.CHAT_TEAM_BROADCAST_MS, 1500, 250, 10000);
const controlTimeoutMs = clampInt(process.env.CHAT_TEAM_CONTROL_TIMEOUT_MS, 90000, 5000, 180000);
const maxMessageBytes = 20 * 1024;
const maxParticipants = 8;
const maxRounds = 3;
const skipToken = '[[SKIP]]';

let connection = {
  baseUrl: 'http://127.0.0.1:32123/v1',
  apiKey: '',
  room: 'main',
  model: 'cwapi-web-gpt',
  connected: false,
};

let settings = {
  participants: ['GPT-A', 'GPT-B', 'GPT-C'],
  rounds: 1,
};

const chat = {
  sequence: 0,
  turnCounter: 0,
  messages: [],
  queue: [],
  processing: false,
  participantStates: new Map(),
};

const activeControllers = new Set();
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function sendJson(res, status, value) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw codedError('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw codedError('REQUEST_JSON_INVALID');
  }
}

function codedError(code, message = code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw codedError('INVALID_PROTOCOL');
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw codedError('CWAPI_MUST_BE_LOCAL');
  if (!url.pathname.endsWith('/v1')) url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1`;
  return url.toString().replace(/\/$/, '');
}

function normalizeRoom(value) {
  const room = String(value || 'main').trim() || 'main';
  if (room.length > 64 || /[\\/\r\n]/.test(room)) throw codedError('ROOM_INVALID');
  return room;
}

function normalizeParticipants(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const name = String(item || '').trim();
    if (!name) continue;
    if (name.length > 64 || /[\r\n]/.test(name)) throw codedError('PARTICIPANT_NAME_INVALID');
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  if (!result.length) throw codedError('PARTICIPANTS_REQUIRED');
  if (result.length > maxParticipants) throw codedError('PARTICIPANT_LIMIT');
  return result;
}

function normalizeRounds(value) {
  const rounds = Number(value);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > maxRounds) throw codedError('ROUNDS_INVALID');
  return rounds;
}

function resetParticipantStates() {
  chat.participantStates.clear();
  for (const name of settings.participants) {
    chat.participantStates.set(name, { name, status: 'ready', error: '', lastReplyAt: '' });
  }
}

function participantSnapshot() {
  return settings.participants.map((name) => ({
    name,
    ...(chat.participantStates.get(name) || { status: 'ready', error: '', lastReplyAt: '' }),
  }));
}

function setParticipantState(name, patch) {
  const current = chat.participantStates.get(name) || { name, status: 'ready', error: '', lastReplyAt: '' };
  chat.participantStates.set(name, { ...current, ...patch, name });
}

function appendMessage({ role, sender, content, turnId = '', round = 0 }) {
  chat.sequence += 1;
  const message = {
    sequence: chat.sequence,
    role,
    sender,
    content,
    turn_id: turnId,
    round,
    created_at: new Date().toISOString(),
  };
  chat.messages.push(message);
  if (chat.messages.length > 1000) chat.messages.splice(0, chat.messages.length - 1000);
  return message;
}

function abortAllRequests() {
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
}

async function cwapi(path, init = {}) {
  if (!connection.apiKey) throw codedError('NOT_CONNECTED', '尚未连接 CWapi', 503);
  const headers = new Headers(init.headers || {});
  headers.set('authorization', `Bearer ${connection.apiKey}`);
  if (init.body != null && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let response;
  try {
    response = await fetch(`${connection.baseUrl}${path}`, { ...init, headers });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw codedError('CWAPI_UNREACHABLE', error?.message || 'CWapi unreachable', 502);
  }
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
  if (!response.ok) {
    const code = body?.error?.code || body?.code || body?.error || `CWAPI_HTTP_${response.status}`;
    const message = body?.error?.message || body?.message || String(code);
    throw codedError(String(code), message, response.status);
  }
  return body;
}

function chatCompletionBody(messages, metadata) {
  return {
    model: connection.model || 'cwapi-web-gpt',
    stream: false,
    messages,
    metadata,
  };
}

function broadcastBody({ turnId, sender, content, round, kind }) {
  const senderLabel = sender === 'user' ? '用户' : sender;
  return chatCompletionBody([
    {
      role: 'system',
      content: 'chat-team 共享消息广播。所有 Web GPT 窗口都可能收到此请求。只读取并记住消息，不要对这个 request 提交 completion、tool_call 或 progress。继续 agent_exchange，等待 chat_team_kind=control 且 target 是你自己的控制请求。',
    },
    {
      role: 'user',
      content: `[chat-team shared message]\n发送者：${senderLabel}\n内容：${content}`,
    },
  ], {
    chat_team: true,
    chat_team_kind: 'broadcast',
    chat_team_message_kind: kind,
    chat_team_room: connection.room,
    chat_team_turn: turnId,
    chat_team_sender: sender,
    chat_team_round: round,
  });
}

function controlBody({ turnId, target, round }) {
  return chatCompletionBody([
    {
      role: 'system',
      content: 'chat-team 发言控制请求。只有 metadata.chat_team_target 与你在本网页窗口预先绑定的身份完全一致时，才允许对此 request 提交 completion。其他窗口必须忽略本 request 并继续 agent_exchange。',
    },
    {
      role: 'user',
      content: `现在轮到 ${target} 发言。请基于本窗口此前收到并记住的 chat-team shared message 参与讨论。只返回要显示在聊天室里的正文。若本轮确实没有新的有价值内容，返回 ${skipToken}。`,
    },
  ], {
    chat_team: true,
    chat_team_kind: 'control',
    chat_team_room: connection.room,
    chat_team_turn: turnId,
    chat_team_target: target,
    chat_team_round: round,
  });
}

async function postCompletion(body, signal) {
  return cwapi('/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
}

function extractCompletionText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === 'string' ? part : part?.text || '')
      .join('')
      .trim();
  }
  if (typeof payload?.content === 'string') return payload.content.trim();
  return '';
}

async function broadcastSharedMessage(message) {
  const deadline = Date.now() + broadcastHoldMs;
  let attempts = 0;
  while (connection.connected && Date.now() < deadline && attempts < 8) {
    attempts += 1;
    const controller = new AbortController();
    activeControllers.add(controller);
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      await postCompletion(broadcastBody(message), controller.signal);
      // A broadcast should stay open. If a window incorrectly completes it,
      // immediately re-publish for the remaining hold window.
    } catch (error) {
      if (error?.name !== 'AbortError') throw error;
    } finally {
      clearTimeout(timer);
      activeControllers.delete(controller);
    }
  }
}

async function askParticipant({ turnId, target, round }) {
  const controller = new AbortController();
  activeControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), controlTimeoutMs);
  try {
    const payload = await postCompletion(controlBody({ turnId, target, round }), controller.signal);
    return extractCompletionText(payload);
  } catch (error) {
    if (error?.name === 'AbortError') throw codedError('PARTICIPANT_TIMEOUT', `${target} 等待超时`, 504);
    throw error;
  } finally {
    clearTimeout(timer);
    activeControllers.delete(controller);
  }
}

async function processTurn(turn) {
  await broadcastSharedMessage({
    turnId: turn.id,
    sender: 'user',
    content: turn.content,
    round: 0,
    kind: 'user',
  });

  for (let round = 1; round <= settings.rounds && connection.connected; round += 1) {
    for (const target of settings.participants) {
      if (!connection.connected) return;
      setParticipantState(target, { status: 'replying', error: '' });
      try {
        const reply = await askParticipant({ turnId: turn.id, target, round });
        if (!reply || reply === skipToken) {
          setParticipantState(target, { status: 'ready', error: '' });
          continue;
        }
        const message = appendMessage({ role: 'assistant', sender: target, content: reply, turnId: turn.id, round });
        setParticipantState(target, { status: 'replied', error: '', lastReplyAt: message.created_at });
        await broadcastSharedMessage({
          turnId: turn.id,
          sender: target,
          content: reply,
          round,
          kind: 'peer',
        });
        setParticipantState(target, { status: 'ready', error: '', lastReplyAt: message.created_at });
      } catch (error) {
        const code = error?.code || error?.message || 'PARTICIPANT_FAILED';
        setParticipantState(target, { status: 'error', error: String(code) });
        appendMessage({
          role: 'system',
          sender: '系统',
          content: `${target} 本轮未返回：${code}`,
          turnId: turn.id,
          round,
        });
      }
    }
  }
}

async function pumpQueue() {
  if (chat.processing) return;
  chat.processing = true;
  try {
    while (chat.queue.length && connection.connected) {
      const turn = chat.queue.shift();
      try {
        await processTurn(turn);
      } catch (error) {
        appendMessage({
          role: 'system',
          sender: '系统',
          content: `讨论中断：${error?.code || error?.message || 'UNKNOWN_ERROR'}`,
          turnId: turn.id,
        });
      }
    }
  } finally {
    chat.processing = false;
  }
}

function resetChat() {
  abortAllRequests();
  chat.sequence = 0;
  chat.turnCounter = 0;
  chat.messages = [];
  chat.queue = [];
  chat.processing = false;
  resetParticipantStates();
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, {
      connected: connection.connected,
      baseUrl: connection.baseUrl,
      room: connection.room,
      model: connection.model,
      participants: participantSnapshot(),
      rounds: settings.rounds,
      processing: chat.processing,
      queued_turns: chat.queue.length,
      broadcast_hold_ms: broadcastHoldMs,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/connect') {
    try {
      const body = await readJson(req);
      const next = {
        baseUrl: normalizeBaseUrl(body.baseUrl),
        apiKey: String(body.apiKey || '').trim(),
        room: normalizeRoom(body.room),
      };
      if (!next.apiKey) throw codedError('API_KEY_REQUIRED');
      const nextParticipants = normalizeParticipants(body.participants || settings.participants);
      const nextRounds = normalizeRounds(body.rounds ?? settings.rounds);

      const previous = connection;
      connection = { ...connection, ...next, connected: false };
      try {
        const models = await cwapi('/models', { method: 'GET' });
        const modelIds = Array.isArray(models?.data) ? models.data.map((item) => item?.id).filter(Boolean) : [];
        connection.model = modelIds.includes('cwapi-web-gpt') ? 'cwapi-web-gpt' : (modelIds[0] || 'cwapi-web-gpt');
        connection.connected = true;
        settings = { participants: nextParticipants, rounds: nextRounds };
        resetChat();
        return sendJson(res, 200, {
          connected: true,
          baseUrl: connection.baseUrl,
          room: connection.room,
          model: connection.model,
          models: modelIds,
          participants: participantSnapshot(),
          rounds: settings.rounds,
        });
      } catch (error) {
        connection = previous;
        throw error;
      }
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.code || error.message, message: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/disconnect') {
    connection = { ...connection, apiKey: '', connected: false };
    abortAllRequests();
    chat.queue = [];
    return sendJson(res, 200, { connected: false });
  }

  if (req.method === 'GET' && url.pathname === '/api/messages') {
    const after = Math.max(0, Number(url.searchParams.get('after') || 0));
    return sendJson(res, 200, {
      cursor: chat.sequence,
      messages: chat.messages.filter((item) => item.sequence > after),
      participants: participantSnapshot(),
      processing: chat.processing,
      queued_turns: chat.queue.length,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/messages') {
    try {
      if (!connection.connected) throw codedError('NOT_CONNECTED', '请先连接 CWapi', 503);
      const body = await readJson(req);
      const content = String(body.content || '').trim();
      if (!content) throw codedError('MESSAGE_REQUIRED');
      if (Buffer.byteLength(content, 'utf8') > maxMessageBytes) throw codedError('MESSAGE_TOO_LONG');
      chat.turnCounter += 1;
      const turnId = `turn-${chat.turnCounter}`;
      const message = appendMessage({ role: 'user', sender: '你', content, turnId });
      chat.queue.push({ id: turnId, content });
      void pumpQueue();
      return sendJson(res, 202, { accepted: true, turn_id: turnId, message });
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.code || error.message, message: error.message });
    }
  }

  return sendJson(res, 404, { error: 'NOT_FOUND' });
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(res, pathname) {
  let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  relative = normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, relative);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'NOT_FOUND' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (error) {
    return sendJson(res, 500, { error: 'INTERNAL_ERROR', message: error?.message || 'Internal error' });
  }
});

server.listen(port, host, () => {
  console.log(`chat-team listening on http://${host}:${port}`);
  console.log(`broadcast hold ${broadcastHoldMs}ms, participant timeout ${controlTimeoutMs}ms`);
});
