import { canMarkTab, documentUrl, isPdfTab } from "./core.mjs";
import { handleTranslationMessage } from './translation-background.mjs';

// Keep configuration and decrypted session credentials out of content-script contexts.
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

const OFFSCREEN = "offscreen.html";
const PREFIX = "pdf-tab:";
let enabled = true;
let generation = 0;
let lastError = "";
let queue = Promise.resolve();
const records = new Map();
const ready = Promise.all([
  chrome.storage.local.get({ enabled: true }),
  chrome.storage.session.get(null),
]).then(([settings, session]) => {
  enabled = settings.enabled;
  for (const [key, value] of Object.entries(session)) {
    if (key.startsWith(PREFIX)) records.set(Number(key.slice(PREFIX.length)), value);
  }
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function context() {
  await ready;
  const revision = generation;
  if (!enabled) return null;
  const tab = await activeTab();
  if (!tab || tab.discarded || tab.status === "loading" || !isPdfTab(tab, records.get(tab.id))) return null;
  const window = await chrome.windows.get(tab.windowId);
  if (!window.focused || window.state === "minimized" || revision !== generation || !enabled) return null;
  return { key: `${revision}:${tab.id}:${documentUrl(tab.url)}` };
}

async function saveRecord(tabId, record) {
  records.set(tabId, record);
  await chrome.storage.session.set({ [`${PREFIX}${tabId}`]: record });
}

async function updateBadge(active) {
  await chrome.action.setBadgeText({ text: lastError && active ? "!" : active ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: lastError ? "#b42318" : "#16784b" });
}

async function synchronize() {
  const active = await context();
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN)],
  });
  if (active && existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN,
      reasons: ["CLIPBOARD"],
      justification: "在前台 PDF 标签页检查新复制的文本并将换行替换为空格。",
    });
  } else if (!active && existing.length > 0) {
    await chrome.offscreen.closeDocument();
  }
  await updateBadge(Boolean(active));
}

function schedule() {
  queue = queue.then(synchronize).catch(async () => {
    lastError = "后台服务启动失败，请在扩展管理页面重新加载扩展。";
    await updateBadge(true).catch(() => {});
  });
}

// Observe only top-level response metadata; no page scripts or PDF bodies are read.
chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300) return;
  const type = details.responseHeaders?.find((header) => header.name.toLowerCase() === "content-type")?.value;
  if (!type) return;
  void ready.then(async () => {
    const url = documentUrl(details.url);
    const previous = records.get(details.tabId);
    await saveRecord(details.tabId, {
      url,
      pdf: type.split(";")[0].trim().toLowerCase() === "application/pdf",
      manual: previous?.url === url && Boolean(previous.manual),
    });
    schedule();
  }).catch(() => {});
}, { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] }, ["responseHeaders"]);

chrome.tabs.onActivated.addListener(() => { generation++; schedule(); });
chrome.windows.onFocusChanged.addListener(() => { generation++; schedule(); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && !change.status) return;
  if (tab.active) generation++;
  void ready.then(async () => {
    const record = records.get(tabId);
    if (change.url && record && record.url !== documentUrl(change.url)) {
      records.delete(tabId);
      await chrome.storage.session.remove(`${PREFIX}${tabId}`);
    }
    schedule();
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(async () => {
    records.delete(tabId);
    await chrome.storage.session.remove(`${PREFIX}${tabId}`);
    schedule();
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  void ready.then(() => {
    enabled = changes.enabled.newValue !== false;
    generation++;
    lastError = "";
    schedule();
  });
});

async function handleMessage(message, sender) {
  await ready;
  if (message.type?.startsWith('translation-')) return handleTranslationMessage(message, sender);
  if (message.type === 'open-reader') {
    if (sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('popup.html')) throw new Error('请通过扩展面板打开。');
    const tab = await activeTab();
    const viewer = new URL(chrome.runtime.getURL('pdfjs/web/viewer.html'));
    if (tab?.url?.startsWith(viewer.href)) return { ok: true };
    viewer.searchParams.set('file', '');
    if (tab && isPdfTab(tab, records.get(tab.id)) && /^(https?|file):/.test(tab.url)) viewer.searchParams.set('source', tab.url);
    await chrome.tabs.create({ url: viewer.href });
    return { ok: true };
  }
  if (message.type === "context") return context();
  if (message.type === "health") {
    lastError = message.ok ? "" : "剪贴板访问失败。请确认权限已启用，然后重新加载扩展。";
    await updateBadge(Boolean(await context()));
    return { ok: true };
  }
  if (message.type === "set-manual") {
    const tab = await activeTab();
    if (!tab || tab.id !== message.tabId || documentUrl(tab.url) !== message.url || !canMarkTab(tab.url)) {
      throw new Error("标签页已切换，请重新打开扩展面板。");
    }
    const old = records.get(tab.id);
    await saveRecord(tab.id, {
      ...(old?.url === message.url ? old : {}),
      url: message.url,
      manual: Boolean(message.value),
    });
    generation++;
    schedule();
    return { ok: true };
  }
  if (message.type === "status") {
    const tab = await activeTab();
    const record = records.get(tab?.id);
    return {
      enabled,
      reader: tab?.url?.split(/[?#]/)[0] === chrome.runtime.getURL('pdfjs/web/viewer.html'),
      active: Boolean(await context()),
      pdf: isPdfTab(tab, record),
      manual: record?.url === documentUrl(tab?.url) && Boolean(record?.manual),
      canMark: canMarkTab(tab?.url),
      tabId: tab?.id,
      url: documentUrl(tab?.url),
      error: lastError,
    };
  }
  throw new Error("未知操作。");
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== "background") return false;
  handleMessage(message, sender).then(respond, (error) => respond({ error: error.message }));
  return true;
});
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
schedule();
