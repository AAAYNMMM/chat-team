const $ = (id) => document.getElementById(id);

const state = {
  configured: false,
  cursor: 0,
  pollTimer: null,
  polling: false,
  participants: [],
  totalRounds: 1,
};

const repositoryUrl = $('repositoryUrl');
const room = $('room');
const participantNames = $('participantNames');
const rounds = $('rounds');
const configureButton = $('configureButton');
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

repositoryUrl.value = sessionStorage.getItem('chat-team.repositoryUrl') || repositoryUrl.value;
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
  const repo = repositoryUrl.value.trim() || 'https://github.com/AAAYNMMM/chat-team';
  return `@MCPcoding 你是 chat-team 房间“${roomName}”中的成员“${name}”。先用 coding_open 打开 ${repo} 的 main，然后持续用 coding_exec 运行 node src/member.mjs exchange ${name} ${roomName}；严格按命令返回的 submit/next 操作并继续 exchange，直到我让你退出。不要在网页输出等待或空闲提示。`;
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
    preview.textContent = `${name} · MCPcoding 持久收件箱`;
    card.append(head, preview);
    return card;
  }));
}

function setConfigured(configured, text, error = false) {
  state.configured = configured;
  connectionStatus.textContent = text;
  connectionStatus.className = `status ${configured ? 'online' : error ? 'error' : 'offline'}`;
  liveState.textContent = configured ? '已配置' : '未配置';
  liveState.className = `live-state ${configured ? 'online' : ''}`;
  messageInput.disabled = !configured;
  sendButton.disabled = !configured;
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
  if (item.status === 'waiting_reply') return item.online ? `在线 · 等待第 ${item.round} 轮回复` : `未在线 · 第 ${item.round} 轮待回复`;
  if (item.online) return '在线 · 等待新任务';
  return '离线/未轮询';
}

function renderParticipants(items = state.participants) {
  state.participants = Array.isArray(items) ? items : [];
  participantCount.textContent = String(state.participants.length);
  if (!state.participants.length) {
    participants.className = 'participants empty';
    participants.textContent = '应用房间后显示成员';
    return;
  }
  participants.className = 'participants';
  participants.replaceChildren(...state.participants.map((item) => {
    const row = document.createElement('div');
    row.className = `participant ${item.status === 'waiting_reply' && !item.online ? 'has-error' : ''}`;
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
  head.append(authorNode, time);
  if (Number(message.round) > 0) {
    const roundBadge = document.createElement('span');
    roundBadge.className = 'message-round';
    roundBadge.textContent = `第 ${message.round} 轮`;
    head.append(roundBadge);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = String(message.content ?? '');
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

function updateQueueState(data = {}) {
  if (data.processing) {
    const round = Number(data.active_round || 0);
    const total = Number(data.rounds || state.totalRounds || 1);
    queueState.textContent = round ? `第 ${round}/${total} 轮` : '讨论中';
    if (Number(data.queued_turns || 0)) queueState.textContent += ` · 排队 ${data.queued_turns}`;
    queueState.className = 'queue-state active';
  } else {
    queueState.textContent = Number(data.queued_turns || 0) ? `等待 ${data.queued_turns}` : '空闲';
    queueState.className = 'queue-state';
  }
}

function applyStatus(data) {
  state.totalRounds = Number(data.rounds || state.totalRounds || 1);
  renderParticipants(data.participants || []);
  updateQueueState(data);
  roomTitle.textContent = `# ${data.room || room.value.trim() || 'main'}`;
  roomSubtitle.textContent = `CWapi Coding · 持久消息队列 · ${state.totalRounds} 轮`;
}

async function configure() {
  const names = configuredParticipants();
  if (!names.length) {
    setConfigured(false, '至少配置一个 Web GPT 成员', true);
    return;
  }
  configureButton.disabled = true;
  connectionStatus.textContent = '配置中…';
  connectionStatus.className = 'status offline';
  try {
    const data = await api('/api/configure', {
      method: 'POST',
      body: JSON.stringify({ room: room.value, participants: names, rounds: Number(rounds.value) }),
    });
    sessionStorage.setItem('chat-team.repositoryUrl', repositoryUrl.value.trim());
    sessionStorage.setItem('chat-team.room', data.room);
    sessionStorage.setItem('chat-team.participants', names.join(', '));
    sessionStorage.setItem('chat-team.rounds', String(data.rounds));
    state.cursor = 0;
    messages.querySelectorAll('.message, .error-banner').forEach((node) => node.remove());
    setConfigured(true, '房间已应用');
    applyStatus(data);
    renderJoinPrompts();
    startPolling();
    messageInput.focus();
  } catch (error) {
    setConfigured(false, `配置失败：${error.message}`, true);
  } finally {
    configureButton.disabled = false;
  }
}

async function pollMessages() {
  if (!state.configured || state.polling) return;
  state.polling = true;
  try {
    const roomName = encodeURIComponent(room.value.trim() || 'main');
    const data = await api(`/api/messages?room=${roomName}&after=${state.cursor}`);
    for (const item of Array.isArray(data.messages) ? data.messages : []) {
      appendMessage(item);
      if (Number(item.sequence) > state.cursor) state.cursor = Number(item.sequence);
    }
    if (Number(data.cursor) > state.cursor) state.cursor = Number(data.cursor);
    applyStatus(data);
    connectionStatus.textContent = '房间已应用';
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
  if (!content || !state.configured) return;
  sendButton.disabled = true;
  try {
    await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ room: room.value.trim() || 'main', content }),
    });
    messageInput.value = '';
    resizeComposer();
    await pollMessages();
  } catch (error) {
    showError(`发送失败：${error.message}`);
  } finally {
    sendButton.disabled = !state.configured;
    messageInput.focus();
  }
}

function resizeComposer() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
}

async function attachExistingRoom() {
  try {
    const roomName = encodeURIComponent(room.value.trim() || 'main');
    const data = await api(`/api/status?room=${roomName}`);
    if (!data.configured) {
      setConfigured(false, '未配置');
      renderParticipants([]);
      return;
    }
    setConfigured(true, '房间已存在');
    applyStatus(data);
    startPolling();
  } catch {
    setConfigured(false, '未配置');
  }
}

configureButton.addEventListener('click', configure);
room.addEventListener('input', renderJoinPrompts);
repositoryUrl.addEventListener('input', renderJoinPrompts);
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

setConfigured(false, '未配置');
renderParticipants([]);
void attachExistingRoom();