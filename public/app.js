const $ = (id) => document.getElementById(id);
const REPOSITORY_URL = 'https://github.com/AAAYNMMM/chat-team';

const state = {
  configured: false,
  cursor: 0,
  pollTimer: null,
  polling: false,
  participants: [],
  totalRounds: 1,
  helperReady: false,
};

const webGptUrl = $('webGptUrl');
const helperStatus = $('helperStatus');
const helperFolderButton = $('helperFolderButton');
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
const openAllButton = $('openAllButton');

webGptUrl.value = sessionStorage.getItem('chat-team.webGptUrl') || webGptUrl.value;
room.value = sessionStorage.getItem('chat-team.room') || room.value;
participantNames.value = sessionStorage.getItem('chat-team.participants') || participantNames.value;
rounds.value = sessionStorage.getItem('chat-team.rounds') || rounds.value;

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
  return `@MCPcoding 你是 chat-team 房间“${roomName}”中的成员“${name}”。先用 coding_open 打开 ${REPOSITORY_URL} 的 main，然后持续用 coding_exec 运行 node src/member.mjs exchange ${name} ${roomName}。每次 exchange 都是瞬时调用：严格按返回的 submit/next 操作，命令返回后立即继续下一次 exchange；如果 coding_exec 暂时返回 CODING_COMMAND_ACTIVE，说明另一个成员的瞬时命令正在执行，直接重试同一 exchange，不要退出。不要长时间占用 coding_exec，也不要在网页输出等待、空闲或冲突提示，直到我让你退出。`;
}

function normalizedWebGptUrl() {
  const raw = webGptUrl.value.trim();
  if (!raw) throw new Error('请先填写 Web GPT 页面 URL');
  const url = new URL(raw);
  const host = url.hostname.toLocaleLowerCase();
  const allowed = host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com';
  if (url.protocol !== 'https:' || !allowed) throw new Error('目前自动启动只支持 chatgpt.com / chat.openai.com URL');
  return url;
}

function launchMember(name) {
  if (!state.helperReady) throw new Error('浏览器助手未检测到，请先加载 browser-extension 后刷新本页');
  const url = normalizedWebGptUrl();
  url.searchParams.set('chat_team_prompt', promptFor(name));
  url.searchParams.set('chat_team_autosend', '1');
  sessionStorage.setItem('chat-team.webGptUrl', webGptUrl.value.trim());
  const opened = window.open(url.toString(), '_blank');
  if (!opened) throw new Error('浏览器阻止了新标签页，请允许 chat-team 打开弹出窗口');
  try { opened.opener = null; } catch {}
}

function renderJoinPrompts() {
  const names = configuredParticipants();
  promptCount.textContent = String(names.length);
  openAllButton.disabled = !state.helperReady || !names.length;
  joinPrompts.replaceChildren(...names.map((name) => {
    const card = document.createElement('div');
    card.className = 'prompt-card';
    const head = document.createElement('div');
    head.className = 'prompt-head';
    const title = document.createElement('strong');
    title.textContent = name;
    const button = document.createElement('button');
    button.className = 'mini-button';
    button.textContent = '打开窗口';
    button.disabled = !state.helperReady;
    button.addEventListener('click', () => {
      try {
        launchMember(name);
      } catch (error) {
        showError(error.message);
      }
    });
    head.append(title, button);
    const preview = document.createElement('div');
    preview.className = 'prompt-preview';
    preview.textContent = `${name} · 瞬时 exchange · 自动填充并发送`;
    card.append(head, preview);
    return card;
  }));
}

function setHelperReady(ready) {
  state.helperReady = ready;
  helperStatus.textContent = ready ? '浏览器助手已就绪' : '浏览器助手未检测';
  helperStatus.className = `status ${ready ? 'online' : 'offline'}`;
  renderJoinPrompts();
}

function probeHelper() {
  window.postMessage({ source: 'chat-team-page', type: 'probe-helper' }, '*');
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
  if (item.online) return '在线 · 瞬时轮询';
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
  roomSubtitle.textContent = `CWapi Coding · 瞬时 exchange · 持久消息队列 · ${state.totalRounds} 轮`;
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
    normalizedWebGptUrl();
    const data = await api('/api/configure', {
      method: 'POST',
      body: JSON.stringify({ room: room.value, participants: names, rounds: Number(rounds.value) }),
    });
    sessionStorage.setItem('chat-team.webGptUrl', webGptUrl.value.trim());
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

helperFolderButton.addEventListener('click', async () => {
  helperFolderButton.disabled = true;
  try {
    const data = await api('/api/browser-helper/open-folder', { method: 'POST', body: '{}' });
    helperStatus.textContent = data.opened ? '已打开浏览器助手目录' : `浏览器助手目录：${data.path}`;
    helperStatus.className = 'status online';
  } catch (error) {
    helperStatus.textContent = `打开助手目录失败：${error.message}`;
    helperStatus.className = 'status error';
  } finally {
    helperFolderButton.disabled = false;
  }
});
configureButton.addEventListener('click', configure);
room.addEventListener('input', renderJoinPrompts);
participantNames.addEventListener('input', renderJoinPrompts);
webGptUrl.addEventListener('input', () => sessionStorage.setItem('chat-team.webGptUrl', webGptUrl.value.trim()));
openAllButton.addEventListener('click', () => {
  try {
    for (const name of configuredParticipants()) launchMember(name);
  } catch (error) {
    showError(error.message);
  }
});
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('input', resizeComposer);
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});
window.addEventListener('message', (event) => {
  if (event.source === window && event.data?.source === 'chat-team-browser-helper' && event.data?.type === 'ready') {
    setHelperReady(true);
  }
});
window.addEventListener('beforeunload', stopPolling);

setConfigured(false, '未配置');
setHelperReady(false);
renderParticipants([]);
probeHelper();
setTimeout(probeHelper, 500);
setTimeout(probeHelper, 1500);
void attachExistingRoom();
