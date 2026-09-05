import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const port = Number(process.env.CHAT_TEAM_PORT || 32324);
const root = fileURLToPath(new URL('../public/', import.meta.url));

let connection = {
  baseUrl: 'http://127.0.0.1:32123/v1',
  apiKey: '',
  room: 'main',
  connected: false,
};

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function sendJson(res, status, value) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('INVALID_PROTOCOL');
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('CWAPI_MUST_BE_LOCAL');
  if (!url.pathname.endsWith('/v1')) url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1`;
  return url.toString().replace(/\/$/, '');
}

async function cwapi(path, init = {}) {
  if (!connection.apiKey) throw new Error('NOT_CONNECTED');
  const response = await fetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${connection.apiKey}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `CWAPI_HTTP_${response.status}`);
    error.status = response.status;
    error.code = body?.error?.code || body?.code || `CWAPI_HTTP_${response.status}`;
    throw error;
  }
  return body;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, {
      connected: connection.connected,
      baseUrl: connection.baseUrl,
      room: connection.room,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/connect') {
    try {
      const body = await readJson(req);
      const next = {
        baseUrl: normalizeBaseUrl(body.baseUrl),
        apiKey: String(body.apiKey || '').trim(),
        room: String(body.room || 'main').trim() || 'main',
      };
      if (!next.apiKey) throw new Error('API_KEY_REQUIRED');
      const previous = connection;
      connection = { ...next, connected: false };
      try {
        const models = await cwapi('/models', { method: 'GET', headers: { 'content-type': undefined } });
        connection.connected = true;
        return sendJson(res, 200, {
          connected: true,
          baseUrl: connection.baseUrl,
          room: connection.room,
          models: Array.isArray(models?.data) ? models.data.map((item) => item.id) : [],
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
    return sendJson(res, 200, { connected: false });
  }

  if (req.method === 'GET' && url.pathname === '/api/messages') {
    try {
      const after = Math.max(0, Number(url.searchParams.get('after') || 0));
      const room = encodeURIComponent(connection.room);
      const data = await cwapi(`/team/rooms/${room}/messages?after=${after}`, { method: 'GET', headers: { 'content-type': undefined } });
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, error.status || 502, { error: error.code || error.message, message: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/messages') {
    try {
      const body = await readJson(req);
      const content = String(body.content || '').trim();
      if (!content) return sendJson(res, 400, { error: 'MESSAGE_REQUIRED' });
      if (content.length > 20000) return sendJson(res, 400, { error: 'MESSAGE_TOO_LONG' });
      const room = encodeURIComponent(connection.room);
      const data = await cwapi(`/team/rooms/${room}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content }),
      });
      return sendJson(res, 201, data);
    } catch (error) {
      return sendJson(res, error.status || 502, { error: error.code || error.message, message: error.message });
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
    sendJson(res, 500, { error: 'INTERNAL_ERROR', message: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`chat-team listening on http://${host}:${port}`);
});
