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
  rulesSent: false,
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

function teamRulesText() {
  return `chat-team 多人聊天室规则（仅在本次连接的第一条用户广播发送一次，后续持续遵守）：
1. 你的成员身份由网页启动提示词固定，不要自行改名。当前房间：${connection.room}；成员：${settings.participants.join(', ')}。
2. 每次 agent_exchange 返回的 request 都要独立查看 metadata。
3. chat_team_kind=broadcast：这是所有成员共享的聊天消息。只读取并记住正文，不得对该 request 提交 completion、tool_call、progress 或其他 response；直接继续 agent_exchange。该 request 稍后被本地客户端主动取消是正常行为。
4. chat_team_kind=control：只有 chat_team_target 完全等于你的成员身份时才处理。其他 target 属于别的 Web GPT，不得提交 response，继续等待。
5. 处理属于你的 control 时，结合此前收到的所有 broadcast（用户和其他 Web GPT 发言）正常参与讨论。通过下一次 agent_exchange.responses 对 control 的准确 request_id 提交 completion，response 为 {"content":"你的聊天室发言","finish_reason":"stop"}。不要只在网页里输出而不回传 MCP。
6. 若 control 允许跳过且本轮确实没有新的有价值内容，返回 ${skipToken}。提交后继续 agent_exchange。
7. delivery>1 是同一个 request 的重投，不是新聊天消息。不要调用 agent_close，除非用户明确让你退出聊天室。`;
}

function broadcastBody({ turnId, sender, content, round, kind, includeRules = false }) {
  const senderLabel = sender === 'user' ? '用户' : sender;
  const messages = [];
  if (includeRules) {
    messages.push({ role: 'system', content: teamRulesText() });
  }
  messages.push({
    role: 'user',
    content: `[chat-team broadcast]\n发送者：${senderLabel}\n内容：${content}`,
  });
  return chatCompletionBody(messages, {
    chat_team: true,
    chat_team_protocol: 'broadcast-control-v1',
    chat_team_kind: 'broadcast',
    chat_team_message_kind: kind,
    chat_team_room: connection.room,
    chat_team_turn: turnId,
    chat_team_sender: sender,
    chat_team_round: round,
    chat_team_rules: includeRules ? 'included' : 'remembered',
  });
}

function controlBody({ turnId, target, round }) {
  return chatCompletionBody([
    {
      role: 'user',
      content: `chat-team control：现在轮到 ${target} 发言。按首次 broadcast 中的聊天室规则处理；结合此前共享消息回复。没有新观点可返回 ${skipToken}。`,
    },
  ], {
    chat_team: true,
    chat_team_protocol: 'broadcast-control-v1',
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
  const includeRules = !chat.rulesSent;
  await broadcastSharedMessage({
    turnId: turn.id,
    sender: 'user',
    content: turn.content,
    round: 0,
    kind: 'user',
    includeRules,
  });
  if (includeRules) chat.rulesSent = true;

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
  chat.rulesSent = false;
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
