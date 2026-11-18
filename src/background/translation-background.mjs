import { encryptApiKey, decryptApiKey } from '../translation/crypto.mjs';
import { DEFAULT_TRANSLATION, normalizeEndpoint, translateCaptions, translateText, validateSettings } from '../translation/translation.mjs';
import { normalizeModelSettings } from '../translation/model-presets.mjs';

const pending = new Map();
const settingsKey = 'translationSettings';
const vaultKey = 'translationVault';
const sessionKey = 'translationUnlocked';
const { options_ui, action } = chrome.runtime.getManifest();
const optionsPage = options_ui.page;

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

function pageOptions(settings = {}) {
  return {
    paragraphEnabled: settings.paragraphEnabled ?? DEFAULT_TRANSLATION.paragraphEnabled,
    youtubeEnabled: Boolean(settings.youtubeEnabled),
    target: settings.target ?? DEFAULT_TRANSLATION.target,
  };
}

async function notifyPages() {
  const state = await publicSettings();
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
  const message = { type: 'translation-options-changed', options: pageOptions(state.settings) };
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, message)));
  return state;
}

export async function handleTranslationMessage(message, sender) {
  const reader = extensionPage(sender, ['pdfjs/web/viewer.html']);
  const webpage = sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) && /^(https?|file):\/\//.test(sender.url || '');
  if (webpage && message.type === 'translation-page-options') {
    return pageOptions((await chrome.storage.local.get(settingsKey))[settingsKey]);
  }
  if (message.type === 'translation-settings' && (reader || extensionPage(sender, [optionsPage, action.default_popup]))) return publicSettings();
  if (message.type === 'translation-save') {
    if (!extensionPage(sender, [optionsPage])) throw new Error('请在设置页面操作。');
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
    return notifyPages();
  }
  if (message.type === 'translation-unlock') {
    if (!extensionPage(sender, [optionsPage])) throw new Error('请在设置页面解锁。');
    const stored = await chrome.storage.local.get([settingsKey, vaultKey]);
    const endpoint = normalizeEndpoint(stored[settingsKey]?.baseUrl || '');
    const apiKey = await decryptApiKey(stored[vaultKey], message.password, endpoint);
    // storage.session is RAM-only and restricted to trusted extension contexts.
    await chrome.storage.session.set({ [sessionKey]: { endpoint, apiKey } });
    return notifyPages();
  }
  if (message.type === 'translation-lock' || message.type === 'translation-delete-key') {
    if (!extensionPage(sender, [optionsPage])) throw new Error('请在设置页面操作。');
    cancelAll();
    await chrome.storage.session.remove(sessionKey);
    if (message.type === 'translation-delete-key') await chrome.storage.local.remove(vaultKey);
    return notifyPages();
  }
  const scope = reader ? 'reader' : message.scope;
  const youtube = webpage && /^https:\/\/(?:www\.|m\.)?youtube\.com\/|^https:\/\/www\.youtube-nocookie\.com\//.test(sender.url);
  if (!reader && !(webpage && scope === 'paragraph') && !(youtube && scope === 'youtube')) throw new Error('此页面不能访问翻译服务。');
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 100) throw new Error('翻译请求无效。');
  const document = sender.documentId || `${sender.tab?.id}:${sender.frameId}`;
  const owner = JSON.stringify([document, scope, scope === 'paragraph' ? message.requestId : '']);
  if (message.type === 'translation-cancel') {
    const job = pending.get(owner);
    if (job?.requestId === message.requestId) job.controller.abort();
    return { ok: true };
  }
  if (message.type !== (scope === 'youtube' ? 'translation-captions' : 'translation-run')) throw new Error('未知翻译操作。');
  pending.get(owner)?.controller.abort();
  const controller = new AbortController();
  const job = { controller, requestId: message.requestId, tabId: sender.tab?.id };
  pending.set(owner, job);
  let timer, timeout, timedOut = false;
  // Keep the worker alive only while this bounded translation request is pending.
  const keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  try {
    const saved = (await chrome.storage.local.get(settingsKey))[settingsKey];
    const settings = { ...DEFAULT_TRANSLATION, ...saved, ...normalizeModelSettings(saved) };
    if (reader && !settings.enabled) throw new Error('复制翻译尚未开启，请在翻译设置中启用。');
    if (scope === 'paragraph' && !settings.paragraphEnabled) throw new Error('网页段落翻译已关闭。');
    if (scope === 'youtube' && !settings.youtubeEnabled) throw new Error('YouTube 双语字幕已关闭。');
    let apiKey;
    if (settings.provider === 'model') {
      const unlocked = (await chrome.storage.session.get(sessionKey))[sessionKey];
      if (unlocked?.endpoint === normalizeEndpoint(settings.baseUrl)) apiKey = unlocked.apiKey;
    }
    controller.signal.throwIfAborted();
    timeout = settings.provider === 'model' ? settings.timeoutSeconds : 25;
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout * 1000);
    const options = { settings, apiKey, signal: controller.signal };
    if (scope === 'youtube') {
      const translations = await translateCaptions({ ...options, texts: message.texts });
      return { translations, requestId: message.requestId, target: settings.target };
    }
    const translation = await translateText({ ...options, text: message.text });
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
