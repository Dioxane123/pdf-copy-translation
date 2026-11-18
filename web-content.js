// Shared only by the extension's isolated content scripts in this frame.
const webTranslation = (() => {
  const listeners = new Set();
  let preferences;
  async function send(type, fields = {}) {
    const result = await chrome.runtime.sendMessage({ target: 'background', type, ...fields });
    if (!result || result.error) throw new Error(result?.error || '翻译后台未响应。');
    return result;
  }
  function options() {
    if (!preferences) preferences = send('translation-page-options').catch(error => {
      preferences = undefined;
      throw error;
    });
    return preferences;
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type !== 'translation-options-changed') return;
    preferences = Promise.resolve(message.options);
    for (const listener of listeners) listener(message.options);
  });
  return {
    send, options, onChange: listener => listeners.add(listener),
    requestId: () => crypto.getRandomValues(new Uint32Array(4)).join('-'),
    cancel: (scope, requestId) => send('translation-cancel', { scope, requestId }).catch(() => {}),
  };
})();

(() => {
  if (!['text/html', 'application/xhtml+xml'].includes(document.contentType)) return;
  const editable = 'input,textarea,select,[role="textbox"],[contenteditable]:not([contenteditable="false"])';
  const excluded = editable + ',button,[data-pdf-copy-translation],.html5-video-player';
  const paragraphs = 'p,h1,h2,h3,h4,h5,h6,li,dt,dd,blockquote,figcaption,td,th,pre';
  const views = new WeakMap();
  let pointer, armed;

  function paragraphAtPointer() {
    if (!pointer || document.designMode === 'on' || document.activeElement?.closest(editable)) return null;
    let element = document.elementFromPoint(pointer.x, pointer.y);
    if (element?.closest(excluded)) return null;
    for (; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
      if (!(element instanceof HTMLElement)) continue;
      const semantic = element.matches(paragraphs);
      if (!semantic && !['block', 'list-item', 'flow-root', 'flex', 'grid'].includes(getComputedStyle(element).display)) continue;
      // Layout containers can hold an entire page. Pick a block of prose under the pointer.
      if (element.querySelector(paragraphs + ',article,section,div,input,textarea,[contenteditable="true"]')) return null;
      if (element.innerText.trim()) return element;
    }
    return null;
  }

  function remove(block) {
    const view = views.get(block);
    if (!view) return;
    views.delete(block);
    view.observer.disconnect();
    view.host.remove();
    if (view.requestId) void webTranslation.cancel('paragraph', view.requestId);
  }

  async function translate(block) {
    const options = await webTranslation.options();
    if (!options.paragraphEnabled || !block.isConnected) return;
    const previous = views.get(block);
    if (previous) {
      remove(block);
      if (!previous.failed) return;
    }
    const text = block.innerText.trim();
    if (!text) return;
    const host = document.createElement('span');
    host.dataset.pdfCopyTranslation = 'paragraph';
    host.setAttribute('translate', 'no');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{display:block!important;grid-column:1/-1;flex-basis:100%;margin:.35em 0 .15em;padding-inline-start:.7em;border-inline-start:2px solid #599a84;text-align:start;cursor:text;font:inherit;line-height:1.55;overflow-wrap:anywhere;white-space:pre-wrap}button{font:inherit;color:inherit;margin-inline-start:.6em;cursor:pointer}';
    const result = document.createElement('span');
    result.setAttribute('role', 'status');
    result.textContent = '正在翻译…';
    root.append(style, result);
    block.append(host);
    const view = { host, requestId: webTranslation.requestId(), observer: new MutationObserver(() => remove(block)) };
    views.set(block, view);
    view.observer.observe(block, { subtree: true, childList: true, characterData: true });
    try {
      const response = await webTranslation.send('translation-run', { scope: 'paragraph', requestId: view.requestId, text });
      if (views.get(block) !== view) return;
      result.lang = response.target;
      result.dir = 'auto';
      result.textContent = response.translation;
    } catch (error) {
      if (views.get(block) !== view) return;
      view.failed = true;
      result.textContent = error.message;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重试';
      retry.addEventListener('click', event => {
        if (event.isTrusted) { event.preventDefault(); event.stopPropagation(); void translate(block).catch(() => {}); }
      });
      root.append(retry);
    } finally { view.requestId = null; }
  }

  // Wait for keyup so Shift+letter, Shift+click and selection shortcuts keep their usual meaning.
  window.addEventListener('pointermove', event => { if (event.isTrusted) pointer = { x: event.clientX, y: event.clientY }; }, { passive: true, capture: true });
  window.addEventListener('pointerout', event => { if (!event.relatedTarget) { pointer = null; armed = null; } }, true);
  window.addEventListener('pointerdown', () => { armed = null; }, true);
  window.addEventListener('wheel', () => { armed = null; }, { passive: true, capture: true });
  window.addEventListener('blur', () => { armed = null; }, true);
  window.addEventListener('keydown', event => {
    if (!event.isTrusted || event.repeat) return;
    armed = event.key === 'Shift' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing ? paragraphAtPointer() : null;
  }, true);
  window.addEventListener('keyup', event => {
    const block = armed;
    armed = null;
    if (event.isTrusted && event.key === 'Shift' && block && block === paragraphAtPointer()) void translate(block).catch(() => {});
  }, true);
  function clearViews() {
    for (const host of document.querySelectorAll('[data-pdf-copy-translation="paragraph"]')) remove(host.parentElement);
  }
  window.addEventListener('pagehide', clearViews);
  webTranslation.onChange(clearViews);
})();
