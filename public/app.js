const $ = (id) => document.getElementById(id);

const state = {
  connected: false,
  cursor: 0,
  pollTimer: null,
  polling: false,
  participants: [],
};

const baseUrl = $('baseUrl');
const apiKey = $('apiKey');
const room = $('room');
const participantNames = $('participantNames');
const rounds = $('rounds');
const connectButton = $('connectButton');
const connectionStatus = $('connectionStatus');
const liveState = $('liveState');
const queueState = $('queueState');
const roomTitle = $('roomTitle');
const roomSubtitle = $('roomSubtitle');
const messages = $('messages');
const messageInput = $('messageInput');
const sendButton = $('sendButton');
const participants = $('participants');
const participantCount = $('participantCount');
const joinPrompts = $('joinPrompts');
const promptCount = $('promptCount');

baseUrl.value = sessionStorage.getItem('chat-team.baseUrl') || baseUrl.value;
room.value = sessionStorage.getItem('chat-team.room') || room.value;
participantNames.value = sessionStorage.getItem('chat-team.participants') || participantNames.value;
rounds.value = sessionStorage.getItem('chat-team.rounds') || rounds.value;
renderJoinPrompts();

function configuredParticipants() {
  const seen = new Set();
  return participantNames.value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => {
      if (!item) return false;
      const key = item.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function promptFor(name) {
  const roomName = room.value.trim() || 'main';
  return `@MCPagent 你是 chat-team 房间“${roomName}”中的成员“${name}”。调用 agent_open 后持续 agent_exchange；聊天室规则会随第一条用户消息发送。除非我让你退出，否则不要在网页输出“等待/不能抢答/不是我的请求”等提示，只持续处理 MCP。`;
}
function renderJoinPrompts() {
  const names = configuredParticipants();
  promptCount.textContent = String(names.length);
  joinPrompts.replaceChildren(...names.map((name) => {
    const card = document.createElement('div');
    card.className = 'prompt-card';

    const head = document.createElement('div');
    head.className = 'prompt-head';
    const title = document.createElement('strong');
    title.textContent = name;
    const button = document.createElement('button');
    button.className = 'mini-button';
    button.textContent = '复制';
    button.addEventListener('click', async () => {
      const text = promptFor(name);
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = '已复制';
        setTimeout(() => { button.textContent = '复制'; }, 1200);
      } catch {
        window.prompt(`复制 ${name} 的启动提示词：`, text);
      }
    });
    head.append(title, button);

    const preview = document.createElement('div');
    preview.className = 'prompt-preview';
    preview.textContent = `${name} · 身份绑定`;
    card.append(head, preview);
    return card;
  }));
}

function setConnection(connected, text, error = false) {
  state.connected = connected;
  connectionStatus.textContent = text;
  connectionStatus.className = `status ${connected ? 'online' : error ? 'error' : 'offline'}`;
  liveState.textContent = connected ? '已连接' : '离线';
  liveState.className = `live-state ${connected ? 'online' : ''}`;
  messageInput.disabled = !connected;
  sendButton.disabled = !connected;
}

function initials(name) {
  const text = String(name || '?').trim();
  return text.slice(0, 2).toUpperCase();
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusText(item) {
  switch (item.status) {
    case 'replying': return '等待该窗口回复';
    case 'replied': return '刚刚已回复';
    case 'error': return `异常 · ${item.error || '未返回'}`;
    default: return '待命 · 在线状态由网页窗口决定';
  }
}

function renderParticipants(items = state.participants) {
  state.participants = Array.isArray(items) ? items : [];
  participantCount.textContent = String(state.participants.length);
  if (!state.participants.length) {
    participants.className = 'participants empty';
    participants.textContent = '连接后显示配置成员';
    return;
  }
  participants.className = 'participants';
  participants.replaceChildren(...state.participants.map((item) => {
    const row = document.createElement('div');
    row.className = `participant ${item.status === 'error' ? 'has-error' : ''}`;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(item.name);
    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'participant-name';
    name.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'participant-meta';
    meta.textContent = statusText(item);
    text.append(name, meta);
    row.append(avatar, text);
    return row;
  }));
}

function removeWelcome() {
  const welcome = messages.querySelector('.welcome');
  if (welcome) welcome.remove();
}

function appendMessage(message) {
  if (message.sequence && messages.querySelector(`[data-sequence="${message.sequence}"]`)) return;
  removeWelcome();
  const role = message.role || 'assistant';
  const sender = message.sender || (role === 'user' ? '你' : role === 'system' ? '系统' : 'Web GPT');

  const row = document.createElement('article');
  row.className = `message ${role}`;
  row.dataset.sequence = String(message.sequence || '');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = initials(sender);

  const card = document.createElement('div');
  card.className = 'message-card';
  const head = document.createElement('div');
  head.className = 'message-head';
  const authorNode = document.createElement('span');
  authorNode.className = 'message-author';
  authorNode.textContent = sender;
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = formatTime(message.created_at);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = String(message.content ?? '');

  head.append(authorNode, time);
  card.append(head, bubble);
  row.append(avatar, card);
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
}

function showError(text) {
  const current = messages.querySelector('.error-banner');
  if (current) current.remove();
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = text;
  messages.prepend(banner);
}

async function api(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || `HTTP ${response.status}`);
    error.code = body.error;
    error.status = response.status;
    throw error;
  }
  return body;
}

function updateQueueState(processing, queued) {
  if (processing) {
    queueState.textContent = queued ? `讨论中 · 排队 ${queued}` : '讨论中';
    queueState.className = 'queue-state active';
  } else {
    queueState.textContent = queued ? `等待 ${queued}` : '空闲';
    queueState.className = 'queue-state';
  }
}

async function connect() {
  const names = configuredParticipants();
  if (!names.length) {
    setConnection(false, '至少配置一个 Web GPT 成员', true);
    return;
  }
  connectButton.disabled = true;
  connectionStatus.textContent = '连接中…';
  connectionStatus.className = 'status offline';
  try {
    const data = await api('/api/connect', {
      method: 'POST',
      body: JSON.stringify({
        baseUrl: baseUrl.value,
        apiKey: apiKey.value,
        room: room.value,
        participants: names,
        rounds: Number(rounds.value),
      }),
    });
    sessionStorage.setItem('chat-team.baseUrl', data.baseUrl);
    sessionStorage.setItem('chat-team.room', data.room);
    sessionStorage.setItem('chat-team.participants', names.join(', '));
    sessionStorage.setItem('chat-team.rounds', String(data.rounds));
    roomTitle.textContent = `# ${data.room}`;
    roomSubtitle.textContent = `CWapi 原版 Agent · ${data.model || 'cwapi-web-gpt'} · ${data.rounds} 轮`;
    state.cursor = 0;
    messages.querySelectorAll('.message, .error-banner').forEach((node) => node.remove());
    renderParticipants(data.participants || []);
    setConnection(true, '连接成功');
    updateQueueState(false, 0);
    startPolling();
    messageInput.focus();
  } catch (error) {
    setConnection(false, `连接失败：${error.message}`, true);
  } finally {
    connectButton.disabled = false;
  }
}

async function pollMessages() {
  if (!state.connected || state.polling) return;
  state.polling = true;
  try {
    const data = await api(`/api/messages?after=${state.cursor}`);
    renderParticipants(data.participants || []);
    for (const item of Array.isArray(data.messages) ? data.messages : []) {
      appendMessage(item);
      if (Number(item.sequence) > state.cursor) state.cursor = Number(item.sequence);
    }
    if (Number(data.cursor) > state.cursor) state.cursor = Number(data.cursor);
    updateQueueState(Boolean(data.processing), Number(data.queued_turns || 0));
    connectionStatus.textContent = '连接成功';
    connectionStatus.className = 'status online';
  } catch (error) {
    connectionStatus.textContent = `同步失败：${error.message}`;
    connectionStatus.className = 'status error';
  } finally {
    state.polling = false;
  }
}

function startPolling() {
  stopPolling();
  void pollMessages();
  state.pollTimer = setInterval(pollMessages, 500);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function sendMessage() {
  const content = messageInput.value.trim();
  if (!content || !state.connected) return;
  sendButton.disabled = true;
  try {
    await api('/api/messages', { method: 'POST', body: JSON.stringify({ content }) });
    messageInput.value = '';
    resizeComposer();
    await pollMessages();
  } catch (error) {
    showError(`发送失败：${error.message}`);
  } finally {
    sendButton.disabled = !state.connected;
    messageInput.focus();
  }
}

function resizeComposer() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
}

connectButton.addEventListener('click', connect);
room.addEventListener('input', renderJoinPrompts);
participantNames.addEventListener('input', renderJoinPrompts);
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('input', resizeComposer);
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});
window.addEventListener('beforeunload', stopPolling);

setConnection(false, '未连接');
renderParticipants([]);
