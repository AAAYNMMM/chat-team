const $ = (id) => document.getElementById(id);

const state = {
  connected: false,
  cursor: 0,
  pollTimer: null,
  participants: new Map(),
};

const baseUrl = $('baseUrl');
const apiKey = $('apiKey');
const room = $('room');
const connectButton = $('connectButton');
const connectionStatus = $('connectionStatus');
const liveState = $('liveState');
const roomTitle = $('roomTitle');
const roomSubtitle = $('roomSubtitle');
const messages = $('messages');
const messageInput = $('messageInput');
const sendButton = $('sendButton');
const participants = $('participants');
const participantCount = $('participantCount');

baseUrl.value = sessionStorage.getItem('chat-team.baseUrl') || baseUrl.value;
room.value = sessionStorage.getItem('chat-team.room') || room.value;

function setConnection(connected, text, error = false) {
  state.connected = connected;
  connectionStatus.textContent = text;
  connectionStatus.className = `status ${connected ? 'online' : error ? 'error' : 'offline'}`;
  liveState.textContent = connected ? '已连接' : '离线';
  liveState.className = `live-state ${connected ? 'online' : ''}`;
  messageInput.disabled = !connected;
  sendButton.disabled = !connected;
}

function escapeText(value) {
  return String(value ?? '');
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

function authorOf(message) {
  if (message.role === 'user') return { id: 'user', name: '你', kind: 'user' };
  const id = message.participant_id || message.sender_id || message.author_id || 'web-gpt';
  const name = message.participant_name || message.sender_name || message.author_name || 'Web GPT';
  return { id, name, kind: 'agent' };
}

function rememberParticipant(author, message) {
  if (author.kind === 'user') return;
  state.participants.set(author.id, {
    id: author.id,
    name: author.name,
    lastSeen: message.created_at || message.at || new Date().toISOString(),
  });
  renderParticipants();
}

function renderParticipants() {
  const list = [...state.participants.values()];
  participantCount.textContent = String(list.length);
  if (!list.length) {
    participants.className = 'participants empty';
    participants.textContent = '等待成员进入房间';
    return;
  }
  participants.className = 'participants';
  participants.replaceChildren(...list.map((item) => {
    const row = document.createElement('div');
    row.className = 'participant';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(item.name);
    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'participant-name';
    name.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'participant-meta';
    meta.textContent = 'Web GPT';
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
  removeWelcome();
  const author = authorOf(message);
  rememberParticipant(author, message);

  const row = document.createElement('article');
  row.className = `message ${author.kind === 'user' ? 'user' : 'agent'}`;
  row.dataset.sequence = String(message.sequence || message.seq || '');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = initials(author.name);

  const card = document.createElement('div');
  card.className = 'message-card';
  const head = document.createElement('div');
  head.className = 'message-head';
  const authorNode = document.createElement('span');
  authorNode.className = 'message-author';
  authorNode.textContent = author.name;
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = formatTime(message.created_at || message.at);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = escapeText(message.content ?? message.text ?? message.message ?? '');

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

async function connect() {
  connectButton.disabled = true;
  connectionStatus.textContent = '连接中…';
  connectionStatus.className = 'status offline';
  try {
    const data = await api('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: baseUrl.value, apiKey: apiKey.value, room: room.value }),
    });
    sessionStorage.setItem('chat-team.baseUrl', data.baseUrl);
    sessionStorage.setItem('chat-team.room', data.room);
    roomTitle.textContent = `# ${data.room}`;
    roomSubtitle.textContent = data.models?.length ? `CWapi · ${data.models.join(', ')}` : 'CWapi Agent 已连接';
    state.cursor = 0;
    state.participants.clear();
    renderParticipants();
    setConnection(true, '连接成功');
    startPolling();
    messageInput.focus();
  } catch (error) {
    setConnection(false, `连接失败：${error.message}`, true);
  } finally {
    connectButton.disabled = false;
  }
}

async function pollMessages() {
  if (!state.connected) return;
  try {
    const data = await api(`/api/messages?after=${state.cursor}`);
    const items = Array.isArray(data.messages) ? data.messages : [];
    for (const item of items) {
      appendMessage(item);
      const seq = Number(item.sequence || item.seq || 0);
      if (seq > state.cursor) state.cursor = seq;
    }
    if (Number(data.cursor) > state.cursor) state.cursor = Number(data.cursor);
  } catch (error) {
    if (error.status === 404 || error.code === 'NOT_FOUND') {
      showError('当前 CWapi 尚未提供 Team Room 接口。聊天室 UI 已就绪，但需要给 Agent 模式补上共享房间消息总线。');
      stopPolling();
      return;
    }
    connectionStatus.textContent = `同步失败：${error.message}`;
    connectionStatus.className = 'status error';
  }
}

function startPolling() {
  stopPolling();
  pollMessages();
  state.pollTimer = setInterval(pollMessages, 850);
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
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('input', resizeComposer);
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
window.addEventListener('beforeunload', stopPolling);

setConnection(false, '未连接');
renderParticipants();
