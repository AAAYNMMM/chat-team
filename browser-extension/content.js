(() => {
  const READY_SOURCE = 'chat-team-browser-helper';
  const PENDING_PROMPT_KEY = 'chat-team.pendingPrompt';
  const PENDING_AUTOSEND_KEY = 'chat-team.pendingAutosend';

  if (location.hostname === '127.0.0.1' && location.port === '32324') {
    const announce = () => window.postMessage({ source: READY_SOURCE, type: 'ready' }, '*');
    announce();
    window.addEventListener('message', (event) => {
      if (event.source === window && event.data?.source === 'chat-team-page' && event.data?.type === 'probe-helper') announce();
    });
    return;
  }

  const url = new URL(location.href);
  const promptFromUrl = url.searchParams.get('chat_team_prompt');
  const autosendFromUrl = url.searchParams.get('chat_team_autosend');

  if (promptFromUrl) {
    sessionStorage.setItem(PENDING_PROMPT_KEY, promptFromUrl);
    sessionStorage.setItem(PENDING_AUTOSEND_KEY, autosendFromUrl === '1' ? '1' : '0');
    url.searchParams.delete('chat_team_prompt');
    url.searchParams.delete('chat_team_autosend');
    history.replaceState(history.state, '', url.toString());
  }

  const prompt = promptFromUrl || sessionStorage.getItem(PENDING_PROMPT_KEY) || '';
  const autosend = (autosendFromUrl ?? sessionStorage.getItem(PENDING_AUTOSEND_KEY)) === '1';
  if (!prompt) return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const promptPrefix = prompt.slice(0, Math.min(48, prompt.length));

  function composerText(element) {
    if (!element) return '';
    if ('value' in element) return String(element.value || '');
    return String(element.innerText || element.textContent || '');
  }

  function findComposer() {
    return document.querySelector('#prompt-textarea')
      || document.querySelector('[data-testid="prompt-textarea"]')
      || document.querySelector('textarea[placeholder]')
      || document.querySelector('div[contenteditable="true"]');
  }

  function fillComposer(element, text) {
    element.focus();
    if ('value' in element) {
      const prototype = Object.getPrototypeOf(element);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor?.set) descriptor.set.call(element, text);
      else element.value = text;
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, text);
      selection.removeAllRanges();
    } catch {
      element.textContent = text;
    }
    if (!composerText(element).includes(text.slice(0, Math.min(24, text.length)))) {
      element.textContent = text;
    }
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findSendButton() {
    const selectors = [
      '[data-testid="send-button"]',
      '[data-testid="composer-submit-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]'
    ];
    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button && button.isConnected && !button.disabled && button.getAttribute('aria-disabled') !== 'true') return button;
    }
    return null;
  }

  async function waitForComposer(timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const element = findComposer();
      if (element && element.isConnected) return element;
      await sleep(150);
    }
    throw new Error('CHAT_TEAM_COMPOSER_NOT_FOUND');
  }

  async function ensurePromptInComposer(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let composer = await waitForComposer();
    while (Date.now() < deadline) {
      if (!composer.isConnected) composer = await waitForComposer();
      const current = composerText(composer);
      if (!current.includes(promptPrefix)) fillComposer(composer, prompt);
      await sleep(180);
      if (composerText(composer).includes(promptPrefix)) return composer;
    }
    throw new Error('CHAT_TEAM_PROMPT_NOT_RECOGNIZED');
  }

  function clickSend(button) {
    button.focus();
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    button.click();
  }

  async function waitUntilSent(composer, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!composer.isConnected) return true;
      const text = composerText(composer).trim();
      if (!text || !text.includes(promptPrefix)) return true;
      await sleep(120);
    }
    return false;
  }

  async function submitPrompt() {
    let composer = await ensurePromptInComposer();
    const deadline = Date.now() + 45000;
    let attempts = 0;

    while (Date.now() < deadline) {
      if (!composer.isConnected) composer = await ensurePromptInComposer();
      if (!composerText(composer).includes(promptPrefix)) {
        composer = await ensurePromptInComposer();
      }

      const button = findSendButton();
      if (!button) {
        await sleep(180);
        continue;
      }

      attempts += 1;
      clickSend(button);
      if (await waitUntilSent(composer)) {
        sessionStorage.removeItem(PENDING_PROMPT_KEY);
        sessionStorage.removeItem(PENDING_AUTOSEND_KEY);
        return;
      }

      if (attempts >= 8) break;
      await sleep(350);
    }

    throw new Error('CHAT_TEAM_AUTOSEND_FAILED');
  }

  if (autosend) {
    void submitPrompt().catch((error) => console.error('[chat-team helper]', error));
  } else {
    void ensurePromptInComposer();
  }
})();
