import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
export function makePdf() {
  const stream = 'BT /F1 20 Tf 60 740 Td (Alpha first line) Tj 0 -30 Td (Beta second line) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

export async function launchBrowser() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const profile = await mkdtemp(join(tmpdir(), 'pdf-translation-test-'));
  const browser = spawn(process.env.CHROME_BIN || 'chromium', [
    '--headless=new', '--ozone-platform=headless', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--remote-debugging-port=0', '--window-size=1200,900', `--user-data-dir=${profile}`,
    `--disable-extensions-except=${root}`, `--load-extension=${root}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  browser.stderr.on('data', chunk => { log += chunk; });
  browser.on('error', error => { log += error.message; });
  let socket;
  const close = async () => {
    socket?.close(); browser.kill('SIGTERM');
    if (browser.exitCode === null) await new Promise(r => browser.once('exit', r));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  };
  try {
    const info = await until(() => readFile(join(profile, 'DevToolsActivePort'), 'utf8'), 'browser launch');
    const [port, path] = info.trim().split('\n');
    socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
    let id = 0;
    const pending = new Map();
    const events = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) { if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') events.push(message); return; }
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timeout);
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      pending.set(requestId, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
    });
    const attach = async targetId => (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const evaluate = async (session, expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const worker = await until(async () => {
      for (const target of (await send('Target.getTargets')).targetInfos) {
        if (target.type !== 'service_worker' || !target.url.endsWith('/background.js')) continue;
        const session = await attach(target.targetId);
        const name = await evaluate(session, 'chrome.runtime.getManifest().name').catch(() => '');
        await send('Target.detachFromTarget', { sessionId: session });
        if (name === 'PDF 复制换行转空格') return target;
      }
    }, 'extension');
    const origin = worker.url.slice(0, worker.url.lastIndexOf('/'));
    const page = async url => {
      const target = await send('Target.createTarget', { url });
      const session = await attach(target.targetId);
      await send('Runtime.enable', {}, session); await send('Log.enable', {}, session);
      await until(() => evaluate(session, "document.readyState === 'complete'"), 'page load');
      return { ...target, session };
    };
    const shortcut = async (session, key, code = `Key${key.toUpperCase()}`) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers: 2 }, session);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers: 2 }, session);
    };
    return { send, evaluate, page, shortcut, origin, events, log: () => log, close };
  } catch (error) { await close(); throw new Error(`${error.message}\n${log}`); }
}
