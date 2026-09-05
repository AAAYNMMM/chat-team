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

async function waitFor(url, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test('chat-team proxies one user message into the CWapi team room', async (t) => {
  const seen = [];
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
    if (req.method === 'GET' && req.url?.startsWith('/v1/team/rooms/main/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ room: 'main', cursor: 0, messages: [], participants: [] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/team/rooms/main/messages') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push(body);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cursor: 1, message: { sequence: 1, role: 'user', content: body.content } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });
  const cwapiPort = await listen(mock);
  t.after(() => mock.close());

  const reserve = http.createServer();
  const chatPort = await listen(reserve);
  await new Promise((resolve) => reserve.close(resolve));

  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, CHAT_TEAM_PORT: String(chatPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await waitFor(`http://127.0.0.1:${chatPort}/api/status`);

  const connect = await fetch(`http://127.0.0.1:${chatPort}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${cwapiPort}/v1`, apiKey: 'test-key', room: 'main' }),
  });
  assert.equal(connect.status, 200);
  assert.equal((await connect.json()).connected, true);

  const send = await fetch(`http://127.0.0.1:${chatPort}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'hello team' }),
  });
  assert.equal(send.status, 201);
  assert.deepEqual(seen, [{ role: 'user', content: 'hello team' }]);
});

test('connect rejects a CWapi provider without the team-room surface', async (t) => {
  const mock = http.createServer((req, res) => {
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

  const reserve = http.createServer();
  const chatPort = await listen(reserve);
  await new Promise((resolve) => reserve.close(resolve));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, CHAT_TEAM_PORT: String(chatPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await waitFor(`http://127.0.0.1:${chatPort}/api/status`);

  const connect = await fetch(`http://127.0.0.1:${chatPort}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${cwapiPort}/v1`, apiKey: 'test-key', room: 'main' }),
  });
  assert.equal(connect.status, 404);
});
