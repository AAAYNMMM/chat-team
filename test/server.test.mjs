import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function reservePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startChatTeam(t) {
  const port = await reservePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHAT_TEAM_PORT: String(port),
      CHAT_TEAM_ASSIGNMENT_TIMEOUT_MS: '30000',
      CHAT_TEAM_MEMBER_ONLINE_MS: '30000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(() => child.kill());
  try {
    await waitFor(`http://127.0.0.1:${port}/api/status?room=main`);
  } catch (error) {
    throw new Error(`${error.message}\nserver stderr: ${stderr}`);
  }
  return { port, base: `http://127.0.0.1:${port}` };
}

async function api(base, path, body) {
  const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function configure(base, rounds = 3, participants = ['GPT-A', 'GPT-B', 'GPT-C']) {
  return api(base, '/api/configure', { room: 'main', participants, rounds });
}

async function userMessage(base, content) {
  return api(base, '/api/messages', { room: 'main', content });
}

async function exchange(base, member, response = null, waitMs = 0) {
  return api(base, '/api/member/exchange', {
    room: 'main', member, wait_ms: waitMs, ...(response ? { response } : {}),
  });
}

async function assignment(base, member) {
  const data = await exchange(base, member);
  assert.equal(data.state, 'assignment', `${member} should receive an assignment`);
  return data;
}

async function reply(base, member, assignmentData, content) {
  return exchange(base, member, {
    assignment_id: assignmentData.assignment.id,
    content,
  });
}

test('Coding room keeps per-member unread messages even when GPT-C arrives late', async (t) => {
  const { base } = await startChatTeam(t);
  await configure(base, 3);
  await userMessage(base, '讨论这个设计');

  const a1 = await assignment(base, 'GPT-A');
  const b1 = await assignment(base, 'GPT-B');
  assert.equal(a1.assignment.round, 1);
  assert.equal(b1.assignment.round, 1);
  assert.deepEqual(a1.messages.map((m) => m.content), ['讨论这个设计']);

  await reply(base, 'GPT-A', a1, 'A 第一轮');
  await reply(base, 'GPT-B', b1, 'B 第一轮');

  await new Promise((resolve) => setTimeout(resolve, 120));
  const c1 = await assignment(base, 'GPT-C');
  assert.equal(c1.assignment.round, 1);
  assert.deepEqual(
    c1.messages.filter((m) => m.role !== 'system').map((m) => [m.sender, m.content]),
    [['你', '讨论这个设计'], ['GPT-A', 'A 第一轮'], ['GPT-B', 'B 第一轮']],
  );
  const c2 = await reply(base, 'GPT-C', c1, 'C 第一轮');

  const a2 = await assignment(base, 'GPT-A');
  const b2 = await assignment(base, 'GPT-B');
  assert.equal(c2.state, 'assignment');
  for (const item of [a2, b2, c2]) assert.equal(item.assignment.round, 2);
  assert.equal(c2.messages.some((m) => m.sender === 'GPT-A' && m.content === 'A 第一轮'), false, 'C already read A1 in round 1');
  assert.equal(c2.messages.some((m) => m.sender === 'GPT-C' && m.content === 'C 第一轮'), true, 'C receives its own new room-log entry in the same exchange response that advances to round 2');

  await reply(base, 'GPT-A', a2, 'A 第二轮');
  await reply(base, 'GPT-B', b2, 'B 第二轮');
  const c3 = await reply(base, 'GPT-C', c2, 'C 第二轮');

  const a3 = await assignment(base, 'GPT-A');
  const b3 = await assignment(base, 'GPT-B');
  assert.equal(c3.state, 'assignment');
  for (const item of [a3, b3, c3]) assert.equal(item.assignment.round, 3);

  await reply(base, 'GPT-A', a3, 'A 第三轮');
  await reply(base, 'GPT-B', b3, 'B 第三轮');
  await reply(base, 'GPT-C', c3, 'C 第三轮');

  const transcript = await (await fetch(`${base}/api/messages?room=main&after=0`)).json();
  assert.equal(transcript.processing, false);
  assert.equal(transcript.messages.filter((m) => m.role === 'assistant').length, 9);
  assert.deepEqual(
    transcript.messages.filter((m) => m.role === 'assistant').map((m) => [m.sender, m.round]),
    [
      ['GPT-A', 1], ['GPT-B', 1], ['GPT-C', 1],
      ['GPT-A', 2], ['GPT-B', 2], ['GPT-C', 2],
      ['GPT-A', 3], ['GPT-B', 3], ['GPT-C', 3],
    ],
  );
});

test('a member can miss an entire turn interval and still receive all unread context later', async (t) => {
  const { base } = await startChatTeam(t);
  await configure(base, 1);
  await userMessage(base, '第一问');
  const a1 = await assignment(base, 'GPT-A');
  const b1 = await assignment(base, 'GPT-B');
  const c1 = await assignment(base, 'GPT-C');
  await reply(base, 'GPT-A', a1, 'A1');
  await reply(base, 'GPT-B', b1, 'B1');
  await reply(base, 'GPT-C', c1, 'C1');

  await userMessage(base, '第二问');
  const a2 = await assignment(base, 'GPT-A');
  const b2 = await assignment(base, 'GPT-B');
  await reply(base, 'GPT-A', a2, 'A2');
  await reply(base, 'GPT-B', b2, 'B2');

  const c2 = await assignment(base, 'GPT-C');
  assert.deepEqual(
    c2.messages.filter((m) => m.role !== 'system').map((m) => [m.sender, m.content]),
    [['GPT-A', 'A1'], ['GPT-B', 'B1'], ['GPT-C', 'C1'], ['你', '第二问'], ['GPT-A', 'A2'], ['GPT-B', 'B2']],
  );
  await reply(base, 'GPT-C', c2, 'C2');
});

test('duplicate assignment submissions are idempotent', async (t) => {
  const { base } = await startChatTeam(t);
  await configure(base, 1, ['GPT-A']);
  await userMessage(base, '只问 A');
  const a1 = await assignment(base, 'GPT-A');
  const response = { assignment_id: a1.assignment.id, content: '唯一回复' };
  await exchange(base, 'GPT-A', response);
  await exchange(base, 'GPT-A', response);
  const transcript = await (await fetch(`${base}/api/messages?room=main&after=0`)).json();
  assert.equal(transcript.messages.filter((m) => m.role === 'assistant').length, 1);
  assert.equal(transcript.messages.find((m) => m.role === 'assistant').content, '唯一回复');
});

test('member CLI talks to the local Coding room API', async (t) => {
  const { port, base } = await startChatTeam(t);
  await configure(base, 1, ['GPT-A']);
  await userMessage(base, 'CLI 测试');
  const { stdout } = await execFileAsync(process.execPath, ['src/member.mjs', 'exchange', 'GPT-A', 'main'], {
    cwd: process.cwd(),
    env: { ...process.env, CHAT_TEAM_URL: `http://127.0.0.1:${port}`, CHAT_TEAM_EXCHANGE_WAIT_MS: '0' },
  });
  const payload = JSON.parse(stdout);
  assert.equal(payload.state, 'assignment');
  assert.equal(payload.member, 'GPT-A');
  assert.equal(payload.messages[0].content, 'CLI 测试');
  assert.deepEqual(payload.submit.argv.slice(0, 5), ['src/member.mjs', 'exchange', 'GPT-A', 'main', payload.assignment.id]);
});