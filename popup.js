const enabled = document.getElementById("enabled");
const manual = document.getElementById("manual");
const status = document.getElementById("status");
let current;

async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ target: "background", type, ...data });
  if (!response || (response.error && type !== "status")) throw new Error(response?.error || "后台服务未响应。");
  return response;
}

async function render() {
  current = await send("status");
  enabled.checked = current.enabled;
  manual.checked = current.manual;
  manual.disabled = !current.canMark;
  status.textContent = current.reader ? (current.enabled ? '扩展阅读模式 · 复制即时处理' : '扩展阅读模式 · 换行处理已暂停') : !current.enabled ? "已暂停" : current.error || (
    current.active ? "正在运行 · 可以在 PDF 中复制" : current.pdf ? "已识别 PDF · 返回文档后运行" : "待机 · 请打开 PDF 文件"
  );
}

enabled.addEventListener("change", async () => {
  try {
    await chrome.storage.local.set({ enabled: enabled.checked });
    // The storage event is handled asynchronously by the service worker.
    setTimeout(() => render().catch(showError), 150);
  } catch (error) { showError(error); }
});
manual.addEventListener("change", async () => {
  try {
    await send("set-manual", { tabId: current.tabId, url: current.url, value: manual.checked });
    await render();
  } catch (error) { showError(error); }
});
function showError(error) { status.textContent = error.message; }
render().catch(showError);
document.getElementById('open-reader').addEventListener('click', async () => {
  try { await send('open-reader'); window.close(); } catch (error) { showError(error); }
});
document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
