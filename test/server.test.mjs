import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function reservePort() {
  const reserve = http.createServer();
  const port = await listen(reserve);
  await new Promise((resolve) => reserve.close(resolve));
  return port;
}

async function waitFor(url, predicate = (response) => response.ok, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (await predicate(response)) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function startChatTeam(t, extraEnv = {}) {
  const port = await reservePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHAT_TEAM_PORT: String(port),
      CHAT_TEAM_BROADCAST_MS: '250',
      CHAT_TEAM_BROADCAST_SETTLE_MS: '0',
      CHAT_TEAM_CONTROL_TIMEOUT_MS: '5000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await waitFor(`http://127.0.0.1:${port}/api/status`);
  return port;
}

test('three configured rounds stay concurrent and produce visible replies every round', async (t) => {
  const requests = [];
  const pendingByRound = new Map();
  const mock = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer test-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_api_key' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'cwapi-web-gpt' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readBody(req);
      requests.push(body);
      if (body.metadata?.chat_team_kind === 'broadcast') return;
      if (body.metadata?.chat_team_kind === 'control') {
        const round = Number(body.metadata.chat_team_round);
        const recovery = Boolean(body.metadata.chat_team_recovery);
        if (recovery) {
          const target = body.metadata.chat_team_target;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: `${target} round ${round} recovered` }, finish_reason: 'stop' }],
          }));
          return;
        }
        const list = pendingByRound.get(round) || [];
        list.push({ body, res });
        pendingByRound.set(round, list);
        if (list.length === 3) {
          for (const item of list) {
            const target = item.body.metadata.chat_team_target;
            item.res.writeHead(200, { 'content-type': 'application/json' });
            item.res.end(JSON.stringify({
              choices: [{ message: { role: 'assistant', content: `${target} round ${round}` }, finish_reason: 'stop' }],
            }));
          }
        }
        return;
      }
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
  });
  const cwapiPort = await listen(mock);
  t.after(() => mock.close());

  const chatPort = await startChatTeam(t);
  const connect = await fetch(`http://127.0.0.1:${chatPort}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${cwapiPort}/v1`, apiKey: 'test-key', room: 'main',
      participants: ['GPT-A', 'GPT-B', 'GPT-C'], rounds: 3,
    }),
  });
  assert.equal(connect.status, 200);

  const send = await fetch(`http://127.0.0.1:${chatPort}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello team' }),
  });
  assert.equal(send.status, 202);

  await waitFor(
    `http://127.0.0.1:${chatPort}/api/messages?after=0`,
    async (response) => {
      if (!response.ok) return false;
      const body = await response.clone().json();
      return body.processing === false && body.messages?.filter((item) => item.role === 'assistant').length === 9;
    }, 15000,
  );

  for (const round of [1, 2, 3]) {
    assert.equal(pendingByRound.get(round)?.length, 3, `round ${round} controls must be in flight together`);
  }
  const transcript = await (await fetch(`http://127.0.0.1:${chatPort}/api/messages?after=0`)).json();
  const replies = transcript.messages.filter((item) => item.role === 'assistant');
  assert.equal(replies.length, 9);
  assert.deepEqual(replies.map((item) => item.round), [1, 1, 1, 2, 2, 2, 3, 3, 3]);
  assert.deepEqual(replies.slice(0, 3).map((item) => item.sender), ['GPT-A', 'GPT-B', 'GPT-C']);

  const broadcasts = requests.filter((item) => item.metadata?.chat_team_kind === 'broadcast');
  const controls = requests.filter((item) => item.metadata?.chat_team_kind === 'control');
  assert.equal(broadcasts.length, 4);
  assert.equal(controls.length, 9);
  assert.equal(broadcasts[0].metadata.chat_team_rules, 'included');
  assert.match(broadcasts[0].messages[0].content, /每个成员每轮都要实际发言/);
  assert.match(broadcasts[0].messages[0].content, /不要在网页输出“等待”/);
  assert.equal(broadcasts.slice(1).every((item) => item.metadata.chat_team_message_kind === 'peer_batch'), true);
  assert.equal(controls.every((item) => item.metadata.chat_team_protocol === 'broadcast-control-v2'), true);
  assert.equal(controls.every((item) => item.metadata.chat_team_attempt === 1), true);
  assert.equal(requests.some((item) => JSON.stringify(item).includes('/team/rooms/')), false);
});

test('missing or legacy skip reply is retried and later rounds still continue', async (t) => {
  const requests = [];
  const mock = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'cwapi-web-gpt' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readBody(req);
      requests.push(body);
      if (body.metadata?.chat_team_kind === 'broadcast') return;
      const target = body.metadata.chat_team_target;
      const round = Number(body.metadata.chat_team_round);
      const recovery = Boolean(body.metadata.chat_team_recovery);
      let content = `${target} round ${round}`;
      if (target === 'GPT-A' && round === 1 && !recovery) content = '[[SKIP]]';
      if (target === 'GPT-A' && round === 2) content = recovery ? '' : '[[SKIP]]';
      if (target === 'GPT-A' && round === 1 && recovery) content = 'GPT-A round 1 recovered';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
  });
  const cwapiPort = await listen(mock);
  t.after(() => mock.close());
  const chatPort = await startChatTeam(t);

  await fetch(`http://127.0.0.1:${chatPort}/api/connect`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${cwapiPort}/v1`, apiKey: 'test-key', room: 'main', participants: ['GPT-A', 'GPT-B'], rounds: 3 }),
  });
  await fetch(`http://127.0.0.1:${chatPort}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'retry test' }),
  });

  await waitFor(`http://127.0.0.1:${chatPort}/api/messages?after=0`, async (response) => {
    const body = await response.clone().json();
    return body.processing === false && requests.some((item) => item.metadata?.chat_team_round === 3 && item.metadata?.chat_team_target === 'GPT-A');
  }, 15000);

  const transcript = await (await fetch(`http://127.0.0.1:${chatPort}/api/messages?after=0`)).json();
  assert.equal(transcript.messages.some((item) => item.sender === 'GPT-A' && item.round === 1 && /recovered/.test(item.content)), true);
  assert.equal(transcript.messages.some((item) => item.role === 'system' && item.round === 2 && /GPT-A/.test(item.content)), true);
  assert.equal(transcript.messages.some((item) => item.sender === 'GPT-A' && item.round === 3), true);
  const retries = requests.filter((item) => item.metadata?.chat_team_recovery === true);
  assert.equal(retries.some((item) => item.metadata.chat_team_target === 'GPT-A' && item.metadata.chat_team_round === 1), true);
  assert.equal(retries.some((item) => item.metadata.chat_team_target === 'GPT-A' && item.metadata.chat_team_round === 2), true);
});

test('connect validates only the original /v1/models endpoint', async (t) => {
  const paths = [];
  const mock = http.createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== 'Bearer test-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_api_key' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'cwapi-web-gpt' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
  });
  const cwapiPort = await listen(mock);
  t.after(() => mock.close());

  const chatPort = await startChatTeam(t);
  const connect = await fetch(`http://127.0.0.1:${chatPort}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${cwapiPort}/v1`,
      apiKey: 'test-key',
      room: 'main',
      participants: ['GPT-A'],
      rounds: 1,
    }),
  });
  assert.equal(connect.status, 200);
  assert.deepEqual(paths, ['GET /v1/models']);
});

test('message byte limit is enforced before CWapi dispatch', async (t) => {
  let completions = 0;
  const mock = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'cwapi-web-gpt' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') completions += 1;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
  });
  const cwapiPort = await listen(mock);
  t.after(() => mock.close());
  const chatPort = await startChatTeam(t);

  await fetch(`http://127.0.0.1:${chatPort}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${cwapiPort}/v1`, apiKey: 'test-key', room: 'main', participants: ['GPT-A'], rounds: 1,
    }),
  });

  const oversized = await fetch(`http://127.0.0.1:${chatPort}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '中'.repeat(7000) }),
  });
  assert.equal(oversized.status, 400);
  assert.equal(completions, 0);
});