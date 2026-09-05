import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const port = Number(process.env.CHAT_TEAM_PORT || 32324);
const root = fileURLToPath(new URL('../public/', import.meta.url));
const assignmentTimeoutMs = clampInt(process.env.CHAT_TEAM_ASSIGNMENT_TIMEOUT_MS, 180000, 30000, 600000);
const memberOnlineMs = clampInt(process.env.CHAT_TEAM_MEMBER_ONLINE_MS, 90000, 10000, 600000);
const maxParticipants = 8;
const maxRounds = 6;
const maxMessageBytes = 20 * 1024;
const rooms = new Map();
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function codedError(code, message = code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
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

function normalizeRoom(value) {
  const room = String(value || 'main').trim() || 'main';
  if (room.length > 64 || /[\\/\r\n]/.test(room)) throw codedError('ROOM_INVALID');
  return room;
}

function normalizeMember(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 64 || /[\r\n]/.test(name)) throw codedError('MEMBER_INVALID');
  return name;
}

function normalizeParticipants(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const name = normalizeMember(item);
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  if (!result.length) throw codedError('PARTICIPANTS_REQUIRED');
  if (result.length > maxParticipants) throw codedError('PARTICIPANT_LIMIT', `最多 ${maxParticipants} 个成员`);
  return result;
}

function normalizeRounds(value) {
  const rounds = Number(value);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > maxRounds) {
    throw codedError('ROUNDS_INVALID', `轮数必须为 1-${maxRounds}`);
  }
  return rounds;
}

function createRoom(name, participants = ['GPT-A', 'GPT-B', 'GPT-C'], rounds = 1) {
  return {
    name,
    participants: [...participants],
    rounds,
    generation: 1,
    sequence: 0,
    turnCounter: 0,
    assignmentCounter: 0,
    messages: [],
    turnQueue: [],
    activeTurn: null,
    assignments: new Map(),
    members: new Map(),
    version: 0,
    waiters: new Set(),
  };
}

function getRoom(name, create = false) {
  const normalized = normalizeRoom(name);
  let room = rooms.get(normalized);
  if (!room && create) {
    room = createRoom(normalized);
    rooms.set(normalized, room);
  }
  if (!room) throw codedError('ROOM_NOT_FOUND', `房间 ${normalized} 尚未配置`, 404);
  return room;
}

function signalRoom(room) {
  room.version += 1;
  for (const waiter of [...room.waiters]) waiter();
}

function waitForRoomChange(room, version, waitMs) {
  if (room.version !== version || waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      room.waiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    room.waiters.add(finish);
    if (room.version !== version) finish();
  });
}

function memberState(room, name) {
  let state = room.members.get(name);
  if (!state) {
    state = { name, cursor: 0, lastSeenAt: 0, lastReplyAt: 0 };
    room.members.set(name, state);
  }
  return state;
}

function appendMessage(room, { role, sender, content, turnId = '', round = 0 }) {
  room.sequence += 1;
  const message = {
    sequence: room.sequence,
    role,
    sender,
    content,
    turn_id: turnId,
    round,
    created_at: new Date().toISOString(),
  };
  room.messages.push(message);
  if (room.messages.length > 2000) room.messages.splice(0, room.messages.length - 2000);
  signalRoom(room);
  return message;
}

function participantSnapshot(room) {
  const now = Date.now();
  const activeAssignments = new Map();
  if (room.activeTurn) {
    for (const assignment of room.assignments.values()) {
      if (assignment.turnId === room.activeTurn.id && assignment.round === room.activeTurn.currentRound && assignment.status === 'pending') {
        activeAssignments.set(assignment.member, assignment);
      }
    }
  }
  return room.participants.map((name) => {
    const state = room.members.get(name);
    const assignment = activeAssignments.get(name);
    return {
      name,
      online: Boolean(state?.lastSeenAt && now - state.lastSeenAt <= memberOnlineMs),
      last_seen_at: state?.lastSeenAt ? new Date(state.lastSeenAt).toISOString() : '',
      last_reply_at: state?.lastReplyAt ? new Date(state.lastReplyAt).toISOString() : '',
      status: assignment ? 'waiting_reply' : 'ready',
      round: assignment?.round || 0,
    };
  });
}

function currentAssignments(room) {
  if (!room.activeTurn) return [];
  return [...room.assignments.values()].filter((item) =>
    item.turnId === room.activeTurn.id && item.round === room.activeTurn.currentRound,
  );
}

function findPendingAssignment(room, member) {
  if (!room.activeTurn) return null;
  return currentAssignments(room).find((item) => item.member === member && item.status === 'pending') || null;
}

function startRound(room, turn, round) {
  turn.currentRound = round;
  for (const member of room.participants) {
    room.assignmentCounter += 1;
    const id = `${turn.id}-r${round}-a${room.assignmentCounter}`;
    room.assignments.set(id, {
      id,
      turnId: turn.id,
      member,
      round,
      totalRounds: turn.rounds,
      status: 'pending',
      createdAt: Date.now(),
      deadlineAt: Date.now() + assignmentTimeoutMs,
      completedAt: 0,
    });
  }
  signalRoom(room);
}

function startNextTurn(room) {
  if (room.activeTurn || !room.turnQueue.length) return;
  const turn = room.turnQueue.shift();
  turn.status = 'active';
  room.activeTurn = turn;
  startRound(room, turn, 1);
}

function maybeAdvance(room) {
  const turn = room.activeTurn;
  if (!turn) {
    startNextTurn(room);
    return;
  }
  const assignments = currentAssignments(room);
  if (!assignments.length || assignments.some((item) => item.status === 'pending')) return;
  if (turn.currentRound < turn.rounds) {
    startRound(room, turn, turn.currentRound + 1);
    return;
  }
  turn.status = 'completed';
  turn.completedAt = Date.now();
  room.activeTurn = null;
  signalRoom(room);
  startNextTurn(room);
}

function expireAssignments(room) {
  if (!room.activeTurn) return;
  const now = Date.now();
  let changed = false;
  for (const assignment of currentAssignments(room)) {
    if (assignment.status !== 'pending' || assignment.deadlineAt > now) continue;
    assignment.status = 'timed_out';
    assignment.completedAt = now;
    appendMessage(room, {
      role: 'system',
      sender: '系统',
      content: `${assignment.member} 第 ${assignment.round}/${assignment.totalRounds} 轮等待超时，继续后续讨论。`,
      turnId: assignment.turnId,
      round: assignment.round,
    });
    changed = true;
  }
  if (changed) maybeAdvance(room);
}

function submitMemberReply(room, member, response) {
  const assignmentId = String(response?.assignment_id || '').trim();
  const content = String(response?.content || '').trim();
  if (!assignmentId) throw codedError('ASSIGNMENT_REQUIRED');
  if (!content) throw codedError('REPLY_REQUIRED');
  if (Buffer.byteLength(content, 'utf8') > maxMessageBytes) throw codedError('MESSAGE_TOO_LONG');
  const assignment = room.assignments.get(assignmentId);
  if (!assignment) throw codedError('ASSIGNMENT_NOT_FOUND', '任务已不存在', 404);
  if (assignment.member !== member) throw codedError('ASSIGNMENT_MEMBER_MISMATCH', '该任务不属于当前成员', 403);
  const state = memberState(room, member);
  state.lastSeenAt = Date.now();
  if (assignment.status === 'completed') {
    return { duplicate: true, assignment };
  }
  if (assignment.status !== 'pending') throw codedError('ASSIGNMENT_CLOSED', `任务状态为 ${assignment.status}`, 409);
  assignment.status = 'completed';
  assignment.completedAt = Date.now();
  const message = appendMessage(room, {
    role: 'assistant',
    sender: member,
    content,
    turnId: assignment.turnId,
    round: assignment.round,
  });
  state.lastReplyAt = Date.now();
  maybeAdvance(room);
  return { duplicate: false, assignment, message };
}

function assignmentPayload(room, member, assignment) {
  const state = memberState(room, member);
  const unread = room.messages.filter((item) => item.sequence > state.cursor);
  state.cursor = room.sequence;
  state.lastSeenAt = Date.now();
  return {
    state: 'assignment',
    room: room.name,
    member,
    assignment: {
      id: assignment.id,
      turn_id: assignment.turnId,
      round: assignment.round,
      total_rounds: assignment.totalRounds,
      deadline_at: new Date(assignment.deadlineAt).toISOString(),
    },
    messages: unread,
    instruction: assignment.round === 1
      ? '根据 messages 中的用户问题给出你的独立回答。'
      : '结合 messages 中新增的其他成员回复继续讨论，回应、补充或质疑，避免机械重复上一轮。',
    submit: {
      command: 'node',
      argv: ['src/member.mjs', 'exchange', member, room.name, assignment.id, '<你的聊天室回复>'],
    },
    next_action: '提交回复后继续执行 exchange；不要在网页输出等待提示。',
  };
}

async function memberExchange(room, member, response, waitMs) {
  if (!room.participants.some((item) => item.toLocaleLowerCase() === member.toLocaleLowerCase())) {
    throw codedError('MEMBER_NOT_CONFIGURED', `${member} 不在房间成员列表中`, 403);
  }
  const canonical = room.participants.find((item) => item.toLocaleLowerCase() === member.toLocaleLowerCase());
  const state = memberState(room, canonical);
  state.lastSeenAt = Date.now();
  if (response) submitMemberReply(room, canonical, response);
  expireAssignments(room);

  const deadline = Date.now() + waitMs;
  while (true) {
    expireAssignments(room);
    const assignment = findPendingAssignment(room, canonical);
    if (assignment) return assignmentPayload(room, canonical, assignment);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      state.lastSeenAt = Date.now();
      return {
        state: 'idle',
        room: room.name,
        member: canonical,
        next: { command: 'node', argv: ['src/member.mjs', 'exchange', canonical, room.name] },
        next_action: '立即继续执行同一 exchange 命令等待新任务；不要在网页输出等待/空闲提示。',
      };
    }
    const version = room.version;
    await waitForRoomChange(room, version, Math.min(remaining, 15000));
  }
}

function configureRoom(name, participants, rounds) {
  const existing = rooms.get(name);
  if (existing) {
    for (const waiter of [...existing.waiters]) waiter();
  }
  const room = createRoom(name, participants, rounds);
  rooms.set(name, room);
  signalRoom(room);
  return room;
}

function roomStatus(room) {
  expireAssignments(room);
  return {
    configured: true,
    room: room.name,
    participants: participantSnapshot(room),
    rounds: room.rounds,
    processing: Boolean(room.activeTurn),
    active_turn: room.activeTurn?.id || '',
    active_round: room.activeTurn?.currentRound || 0,
    queued_turns: room.turnQueue.length,
    cursor: room.sequence,
    assignment_timeout_ms: assignmentTimeoutMs,
  };
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const name = normalizeRoom(url.searchParams.get('room') || 'main');
    const room = rooms.get(name);
    if (!room) return sendJson(res, 200, { configured: false, room: name });
    return sendJson(res, 200, roomStatus(room));
  }

  if (req.method === 'POST' && url.pathname === '/api/configure') {
    try {
      const body = await readJson(req);
      const name = normalizeRoom(body.room);
      const participants = normalizeParticipants(body.participants || ['GPT-A', 'GPT-B', 'GPT-C']);
      const rounds = normalizeRounds(body.rounds ?? 1);
      const room = configureRoom(name, participants, rounds);
      return sendJson(res, 200, roomStatus(room));
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.code || error.message, message: error.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/messages') {
    try {
      const room = getRoom(url.searchParams.get('room') || 'main');
      expireAssignments(room);
      const after = Math.max(0, Number(url.searchParams.get('after') || 0));
      return sendJson(res, 200, {
        ...roomStatus(room),
        messages: room.messages.filter((item) => item.sequence > after),
      });
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.code || error.message, message: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/messages') {
    try {
      const body = await readJson(req);
      const room = getRoom(body.room || 'main');
      const content = String(body.content || '').trim();
      if (!content) throw codedError('MESSAGE_REQUIRED');
      if (Buffer.byteLength(content, 'utf8') > maxMessageBytes) throw codedError('MESSAGE_TOO_LONG');
      room.turnCounter += 1;
      const turnId = `turn-${room.turnCounter}`;
      const message = appendMessage(room, { role: 'user', sender: '你', content, turnId, round: 0 });
      room.turnQueue.push({ id: turnId, rounds: room.rounds, status: 'queued', currentRound: 0, createdAt: Date.now() });
      startNextTurn(room);
      return sendJson(res, 202, { accepted: true, turn_id: turnId, message, ...roomStatus(room) });
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.code || error.message, message: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/member/exchange') {
    try {
      const body = await readJson(req);
      const room = getRoom(body.room || 'main');
      const member = normalizeMember(body.member);
      const waitMs = clampInt(body.wait_ms, 45000, 0, 120000);
      const data = await memberExchange(room, member, body.response || null, waitMs);
      return sendJson(res, 200, data);
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

setInterval(() => {
  for (const room of rooms.values()) expireAssignments(room);
}, 2000).unref();

server.listen(port, host, () => {
  console.log(`chat-team coding room listening on http://${host}:${port}`);
  console.log(`assignment timeout ${assignmentTimeoutMs}ms`);
});