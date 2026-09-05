(() => {
  const READY_SOURCE = 'chat-team-browser-helper';

  if (location.hostname === '127.0.0.1' && location.port === '32324') {
    const announce = () => window.postMessage({ source: READY_SOURCE, type: 'ready' }, '*');
    announce();
    window.addEventListener('message', (event) => {
      if (event.source === window && event.data?.source === 'chat-team-page' && event.data?.type === 'probe-helper') announce();
    });
    return;
  }

  const url = new URL(location.href);
  const prompt = url.searchParams.get('chat_team_prompt');
  const autosend = url.searchParams.get('chat_team_autosend') === '1';
  if (!prompt) return;

  url.searchParams.delete('chat_team_prompt');
  url.searchParams.delete('chat_team_autosend');
  history.replaceState(history.state, '', url.toString());

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      element.dispatchEvent(new Event('input', { bubbles: true }));
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
      if (button && !button.disabled) return button;
    }
    return null;
  }

  async function waitForComposer(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const element = findComposer();
      if (element) return element;
      await sleep(100);
    }
    throw new Error('CHAT_TEAM_COMPOSER_NOT_FOUND');
  }

  async function submitPrompt() {
    const composer = await waitForComposer();
    fillComposer(composer, prompt);

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (composerText(composer).trim()) {
        const button = findSendButton();
        if (button) {
          button.click();
          return;
        }
      }
      await sleep(100);
    }

    composer.focus();
    composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
  }
  if (autosend) {
    void submitPrompt().catch((error) => console.error('[chat-team helper]', error));
  } else {
    void waitForComposer().then((composer) => fillComposer(composer, prompt));
  }
})();
