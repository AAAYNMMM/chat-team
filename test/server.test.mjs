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
      CHAT_TEAM_CONTROL_TIMEOUT_MS: '5000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await waitFor(`http://127.0.0.1:${port}/api/status`);
  return port;
}

test('original CWapi surface is enough and shared chat bodies are broadcast once', async (t) => {
  const requests = [];
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
      if (body.metadata?.chat_team_kind === 'broadcast') {
        // Broadcast requests intentionally stay open. chat-team aborts them after
        // a short delivery window, matching the real CWapi request lifecycle.
        return;
      }
      if (body.metadata?.chat_team_kind === 'control') {
        const target = body.metadata.chat_team_target;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: `mock-${target}`,
          choices: [{ index: 0, message: { role: 'assistant', content: `${target} reply` }, finish_reason: 'stop' }],
        }));
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
      baseUrl: `http://127.0.0.1:${cwapiPort}/v1`,
      apiKey: 'test-key',
      room: 'main',
      participants: ['GPT-A', 'GPT-B', 'GPT-C'],
      rounds: 1,
    }),
  });
  assert.equal(connect.status, 200);
  assert.equal((await connect.json()).connected, true);

  const send = await fetch(`http://127.0.0.1:${chatPort}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'hello team' }),
  });
  assert.equal(send.status, 202);

  await waitFor(
    `http://127.0.0.1:${chatPort}/api/messages?after=0`,
    async (response) => {
      if (!response.ok) return false;
      const body = await response.clone().json();
      return body.processing === false && body.messages?.filter((item) => item.role === 'assistant').length === 3;
    },
    10000,
  );

  const transcript = await (await fetch(`http://127.0.0.1:${chatPort}/api/messages?after=0`)).json();
  assert.deepEqual(
    transcript.messages.filter((item) => item.role !== 'system').map((item) => [item.sender, item.content]),
    [
      ['你', 'hello team'],
      ['GPT-A', 'GPT-A reply'],
      ['GPT-B', 'GPT-B reply'],
      ['GPT-C', 'GPT-C reply'],
    ],
  );

  const broadcasts = requests.filter((item) => item.metadata?.chat_team_kind === 'broadcast');
  const controls = requests.filter((item) => item.metadata?.chat_team_kind === 'control');
  assert.equal(broadcasts.length, 4);
  assert.equal(controls.length, 3);
  assert.deepEqual(controls.map((item) => item.metadata.chat_team_target), ['GPT-A', 'GPT-B', 'GPT-C']);
  assert.equal(broadcasts[0].metadata.chat_team_rules, 'included');
  assert.equal(broadcasts[0].messages[0].role, 'system');
  assert.match(broadcasts[0].messages[0].content, /chat-team 多人聊天室规则/);
  assert.match(broadcasts[0].messages[1].content, /hello team/);
  for (const item of broadcasts.slice(1)) {
    assert.equal(item.metadata.chat_team_rules, 'remembered');
    assert.equal(item.messages.length, 1);
    assert.equal(item.messages[0].role, 'user');
    assert.equal(JSON.stringify(item).includes('chat-team 多人聊天室规则'), false);
  }
  for (const item of controls) {
    assert.equal(item.messages.length, 1);
    assert.equal(item.messages[0].role, 'user');
    assert.equal(JSON.stringify(item).includes('chat-team 多人聊天室规则'), false);
  }

  const serialized = requests.map((item) => JSON.stringify(item));
  assert.equal(serialized.filter((item) => item.includes('hello team')).length, 1);
  assert.equal(serialized.filter((item) => item.includes('GPT-A reply')).length, 1);
  assert.equal(serialized.filter((item) => item.includes('GPT-B reply')).length, 1);
  assert.equal(serialized.filter((item) => item.includes('GPT-C reply')).length, 1);

  assert.equal(requests.some((item) => JSON.stringify(item).includes('/team/rooms/')), false);
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
