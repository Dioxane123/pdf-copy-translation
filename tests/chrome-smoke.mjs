// Run with: CHROME_BIN=/path/to/chrome node tests/chrome-smoke.mjs
// Uses an isolated headless profile and clipboard, never your normal browser profile.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceLineBreaksWithSpaces } from "../core.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "pdf-cleaner-test-"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

function makePdf() {
  const stream = "BT /F1 20 Tf 60 740 Td (Alpha first line) Tj 0 -30 Td (Beta second line) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((x) => `${String(x).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

const server = createServer((req, res) => {
  const pdf = ["/document.pdf", "/download"].includes(req.url);
  res.writeHead(200, { "Content-Type": pdf ? "application/pdf" : "text/html" });
  res.end(pdf ? makePdf() : "<!doctype html><title>Ordinary page</title><p>Not a PDF</p>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(process.env.CHROME_BIN || "chromium", [
  "--headless=new", "--ozone-platform=headless", "--no-sandbox",
  "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--disable-sync",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  `--disable-extensions-except=${root}`, `--load-extension=${root}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let browserLog = "";
chrome.stderr.on("data", (chunk) => { browserLog += chunk; });
let socket;
let counter = 0;
const pending = new Map();
try {
  const portInfo = await until(async () => {
    try { return await readFile(join(profile, "DevToolsActivePort"), "utf8"); } catch { return null; }
  }, "Chrome launch");
  const [port, path] = portInfo.trim().split("\n");
  socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, reject) => { socket.addEventListener("open", r); socket.addEventListener("error", reject); });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++counter;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const attach = async (targetId) => (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  const evaluate = async (session, expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const targets = async () => (await send("Target.getTargets")).targetInfos;
  console.log("Browser launched; waiting for extension service worker");
  const worker = await until(async () => {
    for (const target of await targets()) {
      if (target.type !== "service_worker" || !target.url.endsWith("/background.js")) continue;
      const session = await attach(target.targetId);
      const name = await evaluate(session, "chrome.runtime.getManifest().name").catch(() => "");
      await send("Target.detachFromTarget", { sessionId: session });
      if (name === "PDF 复制换行转空格") return target;
    }
    return null;
  }, "extension load");
  console.log("Extension loaded");
  const extensionOrigin = worker.url.slice(0, worker.url.lastIndexOf("/"));
  const control = await send("Target.createTarget", { url: `${extensionOrigin}/popup.html` });
  const controlSession = await attach(control.targetId);
  await until(() => evaluate(controlSession, "typeof chrome?.storage?.local === 'object'").catch(() => false), "control page");
  const status = () => evaluate(controlSession, "chrome.runtime.sendMessage({target:'background',type:'status'})");
  const copy = (text) => evaluate(controlSession, `(() => {
    const field = document.createElement('textarea'); field.value = ${JSON.stringify(text)};
    document.body.append(field); field.select();
    const ok = document.execCommand('copy'); field.remove(); return ok;
  })()`);
  const paste = () => evaluate(controlSession, `(() => {
    const field = document.createElement('textarea'); document.body.append(field); field.focus();
    const ok = document.execCommand('paste'); const text = field.value; field.remove();
    if (!ok) throw new Error('Test paste failed'); return text;
  })()`);
  const setEnabled = (value) => evaluate(controlSession, `chrome.storage.local.set({enabled:${value}})`);
  assert.ok(await copy("Preexisting\nclipboard"));
  const viewer = await send("Target.createTarget", { url: `${base}/document.pdf` });
  const viewerSession = await attach(viewer.targetId);
  await send("Target.activateTarget", { targetId: viewer.targetId });
  await until(async () => (await status()).active, "active PDF");
  await delay(500);
  assert.equal(await paste(), "Preexisting\nclipboard");
  console.log("PASS: entering PDF preserves existing clipboard");
  assert.ok(await copy("Chinese 中文\r\nnext\n\nline\u2028end"));
  await until(async () => (await paste()) === "Chinese 中文 next  line end", "clipboard cleanup");
  console.log("PASS: native clipboard read/write and Unicode newline cleanup");

  // Dispatch real select-all/copy shortcuts into the built-in PDF viewer.
  const shortcut = async (key, code, keyCode) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers: 2 }, viewerSession);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers: 2 }, viewerSession);
  };
  const copyPdf = async () => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 400, y: 200, button: "left", clickCount: 1 }, viewerSession);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 400, y: 200, button: "left", clickCount: 1 }, viewerSession);
    await shortcut("a", "KeyA", 65);
    await shortcut("c", "KeyC", 67);
    await delay(350);
  };
  await setEnabled(false);
  await until(async () => !(await status()).enabled, "pause");
  await delay(500);
  await copy("seed");
  await copyPdf();
  const raw = await paste();
  assert.match(raw, /Alpha first line/);
  assert.match(raw, /Beta second line/);
  assert.match(raw, /[\r\n]/);
  await copy("seed-again");
  await setEnabled(true);
  await until(async () => (await status()).active, "resume");
  await delay(500);
  await copyPdf();
  const cleaned = await paste();
  assert.equal(cleaned, replaceLineBreaksWithSpaces(raw));
  assert.match(cleaned, /Alpha first line +Beta second line/);
  console.log("PASS: real Ctrl+A / Ctrl+C inside Chrome's native PDF viewer");

  await send("Page.navigate", { url: `${base}/ordinary.html` }, viewerSession);
  await until(async () => !(await status()).pdf, "ordinary page");
  await delay(300);
  await copy("Normal\nwebpage");
  await delay(400);
  assert.equal(await paste(), "Normal\nwebpage");
  console.log("PASS: ordinary web pages are unaffected");

  await send("Page.navigate", { url: `${base}/download` }, viewerSession);
  await until(async () => (await status()).active, "PDF without filename extension");
  await delay(500);
  await copy("No\nextension");
  await until(async () => (await paste()) === "No extension", "MIME-detected cleanup");
  console.log("PASS: PDF detection by Content-Type without .pdf suffix");
  await send("Page.navigate", { url: `${base}/error.pdf` }, viewerSession);
  await until(async () => !(await status()).pdf, "HTML with misleading .pdf suffix");
  await delay(300);
  await copy("HTML\nerror");
  await delay(400);
  assert.equal(await paste(), "HTML\nerror");
  console.log("PASS: HTML responses with .pdf suffix are not processed");
  console.log(JSON.stringify(await send("Browser.getVersion")));
} catch (error) {
  console.error(error);
  console.error(browserLog.slice(-5000));
  throw error;
} finally {
  socket?.close();
  chrome.kill("SIGTERM");
  await new Promise((r) => chrome.exitCode !== null ? r() : chrome.once("exit", r));
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
