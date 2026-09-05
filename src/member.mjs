const endpoint = String(process.env.CHAT_TEAM_URL || 'http://127.0.0.1:32324').replace(/\/+$/, '');
const waitMs = Number(process.env.CHAT_TEAM_EXCHANGE_WAIT_MS || 45000);

function usage() {
  console.error('Usage: node src/member.mjs exchange <member> [room] [assignment_id] [reply]');
  process.exit(2);
}

const [command, memberRaw, roomRaw = 'main', assignmentId = '', ...replyParts] = process.argv.slice(2);
if (command !== 'exchange' || !memberRaw) usage();

const member = String(memberRaw).trim();
const room = String(roomRaw || 'main').trim() || 'main';
const reply = replyParts.join(' ').trim();
const body = { room, member, wait_ms: waitMs };
if (assignmentId) {
  if (!reply) {
    console.error('A reply is required when assignment_id is provided.');
    process.exit(2);
  }
  body.response = { assignment_id: assignmentId, content: reply };
}

try {
  const response = await fetch(`${endpoint}/api/member/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(5000, waitMs + 10000)),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) {
    console.error(JSON.stringify({ state: 'error', status: response.status, ...data }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    state: 'error',
    error: error?.name === 'TimeoutError' ? 'CHAT_TEAM_TIMEOUT' : 'CHAT_TEAM_UNREACHABLE',
    message: error?.message || String(error),
    endpoint,
  }, null, 2));
  process.exit(1);
}