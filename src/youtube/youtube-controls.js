function createYouTubeCaptionView({ toggle, retry, ccChanged }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ytp-button pdf-copy-caption-toggle';
  button.setAttribute('aria-label', '字幕翻译');
  const icon = document.createElement('span');
  icon.className = 'pdf-copy-caption-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '文';
  const latin = document.createElement('span');
  latin.textContent = 'A';
  icon.append(latin);
  button.append(icon);

  const overlay = document.createElement('div');
  overlay.dataset.pdfCopyTranslation = 'youtube';
  overlay.setAttribute('translate', 'no');
  overlay.hidden = true;
  const box = document.createElement('div');
  box.className = 'pdf-copy-caption-box';
  const original = document.createElement('div');
  original.className = 'pdf-copy-original';
  const translation = document.createElement('div');
  translation.className = 'pdf-copy-translated';
  original.dir = translation.dir = 'auto';
  const notice = document.createElement('div');
  notice.className = 'pdf-copy-notice';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.textContent = '重试';
  notice.append(status, retryButton);
  box.append(original, translation, notice);
  overlay.append(box);

  function onClick(control, action) {
    control.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.isTrusted) action();
    });
    for (const type of ['keydown', 'keyup']) control.addEventListener(type, event => {
      if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
    });
  }
  onClick(button, toggle);
  onClick(retryButton, retry);

  let player, ccButton, lastTitle, sampledNativeStyle;
  const ccObserver = new MutationObserver(ccChanged);
  function attach(next) {
    if (player !== next) {
      player?.removeAttribute('data-pdf-copy-captions');
      button.remove();
      overlay.remove();
      box.removeAttribute('style');
      sampledNativeStyle = false;
      player = next;
    }
    const cc = player?.querySelector('.ytp-subtitles-button');
    if (cc !== ccButton) {
      ccObserver.disconnect();
      ccButton = cc;
      if (cc) ccObserver.observe(cc, { attributes: true, attributeFilter: ['aria-pressed', 'aria-checked', 'aria-disabled', 'disabled'] });
    }
    if (!player) return;
    const controls = player.querySelector('.ytp-right-controls-left') || player.querySelector('.ytp-right-controls') || cc?.parentElement;
    if (controls && controls.firstElementChild !== button) {
      for (const copy of controls.querySelectorAll('.pdf-copy-caption-toggle')) if (copy !== button) copy.remove();
      controls.prepend(button);
    }
    if (overlay.parentElement !== player) player.append(overlay);
  }

  function nativeCC() {
    if (ccButton?.disabled || ccButton?.getAttribute('aria-disabled') === 'true') return false;
    const pressed = ccButton?.getAttribute('aria-pressed') ?? ccButton?.getAttribute('aria-checked');
    if (pressed === 'true' || pressed === 'false') return pressed === 'true';
    // Embedded players can omit their controls. Fall back to the player API or a showing TextTrack.
    return undefined;
  }

  function setButton(enabled, ccOn) {
    const unavailable = ccButton?.disabled || ccButton?.getAttribute('aria-disabled') === 'true';
    const hint = unavailable ? '（此视频暂无可用字幕）' : ccOn ? '' : '（播放器 CC 已关闭）';
    const title = (enabled ? '关闭字幕翻译' : '开启字幕翻译') + hint;
    if (lastTitle === title) return;
    lastTitle = title;
    button.setAttribute('aria-pressed', String(enabled));
    button.title = button.dataset.tooltipTitle = title;
  }

  function styleBox(preference) {
    const segment = player?.querySelector('.ytp-caption-window-container .ytp-caption-segment, .caption-window .ytp-caption-segment');
    // Native segments disappear in gaps. Keep the last rendered typography
    // until the next segment supplies the player's current style.
    if (!segment && sampledNativeStyle) return;
    const native = segment && getComputedStyle(segment);
    sampledNativeStyle = Boolean(native);
    function set(property, value) {
      if (box.style.getPropertyValue(property) !== value) box.style.setProperty(property, value);
    }
    for (const key of ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'line-height', 'text-shadow']) {
      set(key, native?.getPropertyValue(key) || '');
    }
    set('color', native?.color || preference?.color || '');
    let background = native?.backgroundColor;
    for (let node = segment?.parentElement; background === 'rgba(0, 0, 0, 0)' && node && node !== player; node = node.parentElement) {
      background = getComputedStyle(node).backgroundColor;
    }
    if ((!background || background === 'rgba(0, 0, 0, 0)') && preference?.background && Number.isFinite(preference.backgroundOpacity)) {
      const percent = Math.max(0, Math.min(1, preference.backgroundOpacity)) * 100;
      background = 'color-mix(in srgb, ' + preference.background + ' ' + percent + '%, transparent)';
    }
    set('background-color', background || '');
  }

  function paint({ source = '', translated = '', message = '', failed = false, timeline = false } = {}) {
    player?.toggleAttribute('data-pdf-copy-captions', timeline);
    if (original.textContent !== source) original.textContent = source;
    if (translation.textContent !== translated) translation.textContent = translated;
    if (status.textContent !== message) status.textContent = message;
    if (notice.hidden !== !message) notice.hidden = !message;
    if (retryButton.hidden !== !failed) retryButton.hidden = !failed;
    const hidden = !source && !message;
    if (overlay.hidden !== hidden) overlay.hidden = hidden;
  }

  return { attach, nativeCC, setButton, styleBox, paint, setLanguage: lang => { translation.lang = lang; },
    switchError: message => { button.title = button.dataset.tooltipTitle = message; } };
}
