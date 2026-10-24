import { replaceLineBreaksWithSpaces } from './core.mjs';
import { DEFAULT_TRANSLATION, TARGETS, MAX_TEXT_LENGTH } from './translation.mjs';

export async function startReader(app) {
  await app.initializedPromise;
  let cleanEnabled = true;
  let settings = DEFAULT_TRANSLATION;
  let sequence = 0;
  let requestId = null;
  let copiedText = '';
  let protectedByInteraction = false;
  let pointerInCard = false;
  let rect = null;
  let canCopy = false;

  const bar = document.createElement('div');
  bar.id = 'translation-bar';
  bar.innerHTML = '<span class="brand">PDF 复制助手</span><span id="reader-mode-status"></span><button type="button" id="reader-open">打开本地 PDF</button><button type="button" id="reader-settings">翻译设置</button>';
  document.body.append(bar);
  const welcome = document.createElement('section');
  welcome.id = 'reader-welcome';
  welcome.innerHTML = '<div class="welcome-mark">文 ↔ A</div><h1>读 PDF，复制即翻译</h1><p id="reader-load-message">打开一个 PDF，然后选中文字并复制。</p><button type="button" id="welcome-open">选择本地 PDF</button><p class="welcome-hint">也可以从 PDF 标签页的扩展面板进入。翻译服务可在右上角设置。</p>';
  document.body.append(welcome);
  const card = document.createElement('section');
  card.id = 'translation-card';
  card.hidden = true;
  card.tabIndex = -1;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', '所选文字的译文');
  card.innerHTML = '<header><span id="translation-label">译文</span><span id="translation-retained" hidden>已保留</span><button type="button" id="translation-close" aria-label="关闭译文" title="关闭（Esc）">×</button></header><div id="translation-result" role="status" aria-live="polite"></div><footer><span id="translation-hint">取消选中后收起 · 点击译文可保留</span><button type="button" id="translation-copy" hidden>复制译文</button><button type="button" id="translation-retry" hidden>重试</button><button type="button" id="translation-settings" hidden>设置</button></footer>';
  document.body.append(card);
  const $ = (id) => document.getElementById(id);
  const result = $('translation-result');

  async function send(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
    if (!response || response.error) throw new Error(response?.error || '后台服务没有响应，请重新加载扩展。');
    return response;
  }
  async function refreshSettings() {
    const [saved, translation] = await Promise.all([chrome.storage.local.get({ enabled: true }), send('translation-settings')]);
    cleanEnabled = saved.enabled;
    settings = translation.settings;
    $('reader-mode-status').textContent = settings.enabled
      ? `复制翻译 → ${TARGETS[settings.target]}${settings.provider === 'model' && !translation.unlocked ? ' · 密钥已锁定' : ''}`
      : '复制翻译未开启';
  }
  await refreshSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.enabled || changes.translationSettings || changes.translationVault) || area === 'session' && changes.translationUnlocked) {
      hideCard();
      void refreshSettings().catch(() => { $('reader-mode-status').textContent = '读取设置失败，请重新加载扩展'; });
    }
  });

  function retain() {
    protectedByInteraction = true;
    $('translation-retained').hidden = false;
    $('translation-hint').textContent = '返回 PDF 点击空白处或按 Esc 收起';
  }
  function hideCard() {
    sequence++;
    if (requestId) void send('translation-cancel', { requestId }).catch(() => {});
    requestId = null;
    card.hidden = true;
    result.textContent = '';
    copiedText = '';
    protectedByInteraction = false;
    pointerInCard = false;
  }
  function positionCard() {
    if (card.hidden || !rect) return;
    const margin = 14;
    const width = Math.min(380, innerWidth - margin * 2);
    card.style.width = `${width}px`;
    const height = card.getBoundingClientRect().height;
    const below = rect.bottom + 10;
    const top = below + height <= innerHeight - margin ? below : rect.top - height - 10;
    card.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - width - margin))}px`;
    card.style.top = `${Math.max(48, Math.min(top, innerHeight - height - margin))}px`;
  }
  const observer = new ResizeObserver(positionCard);
  observer.observe(card);
  function selectionInPdf() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const element = (node) => node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const anchor = element(selection.anchorNode);
    const focus = element(selection.focusNode);
    if (!anchor?.closest('.textLayer') || !focus?.closest('.textLayer')) return null;
    const text = selection.toString();
    if (!text.trim()) return null;
    return { text, range: selection.getRangeAt(0) };
  }
  function checkSelection() {
    if (card.hidden || protectedByInteraction || pointerInCard || card.contains(document.activeElement)) return;
    const selection = selectionInPdf();
    if (!selection || replaceLineBreaksWithSpaces(selection.text) !== copiedText) hideCard();
  }
  async function translate(text) {
    const current = ++sequence;
    if (requestId) void send('translation-cancel', { requestId }).catch(() => {});
    requestId = crypto.randomUUID();
    result.textContent = '正在翻译…';
    card.dataset.state = 'loading';
    $('translation-copy').hidden = true;
    $('translation-retry').hidden = true;
    $('translation-settings').hidden = true;
    positionCard();
    try {
      if (text.length > MAX_TEXT_LENGTH) throw new Error('所选文字过长，请选取不超过 12,000 字符的一段。');
      const response = await send('translation-run', { text, requestId });
      if (current !== sequence || card.hidden) return;
      result.textContent = response.translation;
      card.dataset.state = 'ready';
      $('translation-copy').hidden = false;
    } catch (error) {
      if (current !== sequence || card.hidden) return;
      result.textContent = error.message;
      card.dataset.state = 'error';
      $('translation-retry').hidden = false;
      $('translation-settings').hidden = false;
    } finally {
      if (current === sequence) { requestId = null; positionCard(); }
    }
  }

  // Capture before PDF.js's own copy handler so clipboard text stays deterministic.
  window.addEventListener('copy', (event) => {
    if (!event.isTrusted || card.contains(event.target) || card.contains(window.getSelection()?.anchorNode)) return;
    const selection = selectionInPdf();
    if (!selection) return;
    // Respect PDF.js copy permissions before overriding its copy handler.
    if (!canCopy) return;
    const text = replaceLineBreaksWithSpaces(selection.text);
    if (cleanEnabled && event.clipboardData) {
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (!settings.enabled) return;
    copiedText = text;
    const rectangles = Array.from(selection.range.getClientRects()).filter((r) => r.height > 0 && r.width > 0 && r.bottom > 40 && r.top < innerHeight);
    rect = rectangles.at(-1) || selection.range.getBoundingClientRect();
    protectedByInteraction = false;
    pointerInCard = false;
    $('translation-retained').hidden = true;
    $('translation-hint').textContent = '取消选中后收起 · 点击译文可保留';
    $('translation-label').textContent = `译文 · ${TARGETS[settings.target]}`;
    card.hidden = false;
    positionCard();
    void translate(text);
  }, true);

  document.addEventListener('selectionchange', () => setTimeout(checkSelection, 0));
  card.addEventListener('pointerdown', () => { pointerInCard = true; retain(); }, true);
  window.addEventListener('pointerup', () => { pointerInCard = false; });
  card.addEventListener('click', () => { if (!card.hidden) { retain(); card.focus({ preventScroll: true }); } });
  card.addEventListener('focusin', retain);
  document.addEventListener('pointerdown', (event) => {
    if (card.hidden || card.contains(event.target)) return;
    protectedByInteraction = false;
    if (card.contains(document.activeElement)) document.activeElement.blur();
    // A click back into the document ends the retained state, even when selection
    // was already empty and the browser will not emit another selectionchange.
    if (!selectionInPdf()) hideCard();
    else setTimeout(checkSelection, 0);
  }, true);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !card.hidden) { hideCard(); event.stopPropagation(); }
  }, true);
  window.addEventListener('resize', () => { if (!protectedByInteraction) hideCard(); else positionCard(); });
  $('viewerContainer').addEventListener('scroll', () => { if (!protectedByInteraction) hideCard(); }, { passive: true });
  $('translation-close').addEventListener('click', (event) => { event.stopPropagation(); hideCard(); });
  $('translation-retry').addEventListener('click', () => void translate(copiedText));
  $('translation-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(result.textContent); $('translation-hint').textContent = '译文已复制'; }
    catch { $('translation-hint').textContent = '可选中译文后按 Ctrl+C 复制'; }
  });
  for (const id of ['reader-settings', 'translation-settings']) $(id).addEventListener('click', () => chrome.runtime.openOptionsPage());
  for (const id of ['reader-open', 'welcome-open']) $(id).addEventListener('click', () => app.eventBus.dispatch('openfile', { source: window }));
  app.eventBus.on('documentloaded', async () => {
    welcome.hidden = true; hideCard();
    const pdf = app.pdfDocument;
    try {
      const permissions = await pdf.getPermissions();
      if (pdf === app.pdfDocument) canCopy = !permissions || permissions.has(16); // PermissionFlag.COPY
    } catch { canCopy = false; }
  });
  app.eventBus.on('pagesdestroy', () => { canCopy = false; hideCard(); });
  window.addEventListener('pagehide', hideCard);

  const source = new URL(location.href).searchParams.get('source');
  if (source) {
    try {
      const url = new URL(source);
      if (!['https:', 'http:', 'file:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持这个 PDF 地址，请下载后选择本地文件。');
      $('reader-load-message').textContent = '正在打开 PDF…';
      await app.open({ url: url.href, withCredentials: true, isEvalSupported: false });
    } catch {
      $('reader-load-message').textContent = '无法直接打开此 PDF。登录限制或本地文件权限可能阻止读取，请选择已下载的 PDF 文件。';
    }
  }
}
