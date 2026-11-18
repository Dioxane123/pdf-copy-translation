// Configure PDF.js before initialization; PDF-embedded JavaScript must not run
// in this privileged extension page.
document.addEventListener('webviewerloaded', () => {
  const options = window.PDFViewerApplicationOptions;
  options.set('disablePreferences', true);
  options.set('defaultUrl', '');
  options.set('enableScripting', false);
  options.set('enablePermissions', true);
  // PDF.js 6 defaults this optional path on; probing unsupported GPUs emits
  // "No available adapters.". Use its standard renderer across machines.
  options.set('enableWebGPU', false);
  options.set('enableAltTextModelDownload', false);
  options.set('enableGuessAltText', false);
  options.set('enableHighlightFloatingButton', false);
  options.set('externalLinkTarget', 2);
  import('./reader.js').then(({ startReader }) => startReader(window.PDFViewerApplication)).catch(() => {
    const message = document.createElement('p');
    message.textContent = '阅读器启动失败，请重新加载扩展。';
    document.body.append(message);
  });
}, { once: true });
