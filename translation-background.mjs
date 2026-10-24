import { encryptApiKey, decryptApiKey } from './crypto.mjs';
import { DEFAULT_TRANSLATION, normalizeEndpoint, translateText, validateSettings } from './translation.mjs';
import { normalizeModelSettings } from './model-presets.mjs';

const pending = new Map();
const settingsKey = 'translationSettings';
const vaultKey = 'translationVault';
const sessionKey = 'translationUnlocked';

function extensionPage(sender, paths) {
  return sender.id === chrome.runtime.id && paths.some((path) => sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL(path));
}

async function publicSettings() {
  const stored = await chrome.storage.local.get([settingsKey, vaultKey]);
  const session = await chrome.storage.session.get(sessionKey);
  const settings = { ...DEFAULT_TRANSLATION, ...stored[settingsKey], ...normalizeModelSettings(stored[settingsKey]) };
  const endpoint = settings.provider === 'model' && settings.baseUrl ? normalizeEndpoint(settings.baseUrl) : '';
  return { settings, hasKey: Boolean(stored[vaultKey]), unlocked: Boolean(session[sessionKey]?.endpoint === endpoint && session[sessionKey]?.apiKey) };
}

export async function handleTranslationMessage(message, sender) {
  if (!extensionPage(sender, ['options.html', 'popup.html', 'pdfjs/web/viewer.html'])) throw new Error('此页面不能访问翻译服务。');
  if (message.type === 'translation-settings') return publicSettings();
  if (message.type === 'translation-save') {
    if (!extensionPage(sender, ['options.html'])) throw new Error('请在设置页面操作。');
    const settings = validateSettings(message.settings);
    const old = await chrome.storage.local.get(vaultKey);
    let vault = old[vaultKey];
    let unlocked;
    if (settings.provider === 'model') {
      const endpoint = normalizeEndpoint(settings.baseUrl);
      if (message.apiKey) {
        vault = await encryptApiKey(message.apiKey, message.password, endpoint);
        unlocked = { endpoint, apiKey: message.apiKey.trim() };
      } else if (!vault || vault.endpoint !== endpoint) {
        throw new Error('首次配置或修改服务地址时，请输入 API_KEY 和解锁口令。');
      }
    }
    await chrome.storage.local.set({ [settingsKey]: settings, ...(vault ? { [vaultKey]: vault } : {}) });
    if (unlocked) await chrome.storage.session.set({ [sessionKey]: unlocked });
    cancelAll();
    return publicSettings();
  }
  if (message.type === 'translation-unlock') {
    if (!extensionPage(sender, ['options.html'])) throw new Error('请在设置页面解锁。');
    const stored = await chrome.storage.local.get([settingsKey, vaultKey]);
    const endpoint = normalizeEndpoint(stored[settingsKey]?.baseUrl || '');
    const apiKey = await decryptApiKey(stored[vaultKey], message.password, endpoint);
    // storage.session is RAM-only and restricted to trusted extension contexts.
    await chrome.storage.session.set({ [sessionKey]: { endpoint, apiKey } });
    return publicSettings();
  }
  if (message.type === 'translation-lock' || message.type === 'translation-delete-key') {
    if (!extensionPage(sender, ['options.html'])) throw new Error('请在设置页面操作。');
    cancelAll();
    await chrome.storage.session.remove(sessionKey);
    if (message.type === 'translation-delete-key') await chrome.storage.local.remove(vaultKey);
    return publicSettings();
  }
  if (!extensionPage(sender, ['pdfjs/web/viewer.html'])) throw new Error('请在扩展 PDF 阅读模式中翻译。');
  const owner = sender.documentId || `${sender.tab?.id}:${sender.frameId}`;
  if (message.type === 'translation-cancel') {
    const job = pending.get(owner);
    if (job?.requestId === message.requestId) job.controller.abort();
    return { ok: true };
  }
  if (message.type !== 'translation-run') throw new Error('未知翻译操作。');
  const { settings } = await publicSettings();
  if (!settings.enabled) throw new Error('复制翻译尚未开启，请在翻译设置中启用。');
  const session = await chrome.storage.session.get(sessionKey);
  const unlocked = session[sessionKey];
  const apiKey = settings.provider === 'model' && unlocked?.endpoint === normalizeEndpoint(settings.baseUrl) ? unlocked.apiKey : null;
  pending.get(owner)?.controller.abort();
  const controller = new AbortController();
  const job = { controller, requestId: message.requestId, tabId: sender.tab?.id };
  pending.set(owner, job);
  let timedOut = false;
  const timeout = settings.provider === 'model' ? settings.timeoutSeconds : 25;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout * 1000);
  // Keep the worker alive only while this bounded translation request is pending.
  const keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  try {
    const translation = await translateText({ text: message.text, settings, apiKey, signal: controller.signal });
    return { translation, requestId: message.requestId, target: settings.target };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timedOut ? `翻译超过 ${timeout} 秒，可在设置中延长等待上限或降低推理强度。` : '翻译已取消。');
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(keepAlive);
    if (pending.get(owner) === job) pending.delete(owner);
  }
}

function cancelAll() {
  for (const job of pending.values()) job.controller.abort();
  pending.clear();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const job of pending.values()) if (job.tabId === tabId) job.controller.abort();
});
