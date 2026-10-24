// Pass a local PDF path to test an actual document without uploading it anywhere.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { launchBrowser, until, makePdf } from './browser-harness.mjs';

const pdf = process.argv[2] ? await readFile(process.argv[2]) : Buffer.from(makePdf());
const expectGPU = process.env.EXPECT_WEBGPU_PROBE === '1';
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length });
  res.end(pdf);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  browser = await launchBrowser();
  const { page, send, evaluate, origin, shortcut } = browser;
  const reader = await page('about:blank');
  await send('Page.enable', {}, reader.session);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__gpuAdapterRequests = 0;
    if (navigator.gpu) {
      const original = navigator.gpu.requestAdapter.bind(navigator.gpu);
      navigator.gpu.requestAdapter = (...args) => { window.__gpuAdapterRequests++; return original(...args); };
    }
  ` }, reader.session);
  const source = `http://127.0.0.1:${server.address().port}/document.pdf`;
  await send('Page.navigate', { url: `${origin}/pdfjs/web/viewer.html?file=&source=${encodeURIComponent(source)}` }, reader.session);
  await send('Target.activateTarget', { targetId: reader.targetId });
  await until(() => evaluate(reader.session, "PDFViewerApplication.pdfDocument && document.querySelector('.page canvas')?.width > 0 && document.querySelector('.textLayer span') && document.getElementById('reader-welcome')?.hidden"), 'PDF render', 30000);
  const state = await evaluate(reader.session, `({
    enableWebGPU: PDFViewerApplicationOptions.get('enableWebGPU'),
    adapterRequests: window.__gpuAdapterRequests,
    pages: PDFViewerApplication.pdfDocument.numPages,
    fingerprint: PDFViewerApplication.pdfDocument.fingerprints[0],
    textItems: document.querySelectorAll('.textLayer span').length,
  })`);
  assert.equal(state.enableWebGPU, expectGPU);
  assert.equal(state.adapterRequests, expectGPU ? 1 : 0);
  const gpuMessages = browser.events.filter(e => e.params?.entry?.text?.includes('No available adapters'));
  if (!expectGPU) assert.equal(gpuMessages.length, 0);
  assert.equal(browser.events.filter(e => e.method === 'Runtime.exceptionThrown').length, 0);
  console.log(JSON.stringify({ ...state, adapterWarnings: gpuMessages.length }));

  const selection = await evaluate(reader.session, `(() => {
    const spans = Array.from(document.querySelectorAll('.textLayer span')).filter(x => x.textContent.trim());
    const r = document.createRange(); r.setStart(spans[0].firstChild, 0); r.setEnd(spans[1].firstChild, spans[1].textContent.length);
    getSelection().removeAllRanges(); getSelection().addRange(r); return getSelection().toString();
  })()`);
  await shortcut(reader.session, 'c');
  const copied = await evaluate(reader.session, `(() => {
    const field = document.createElement('textarea'); document.body.append(field); field.focus();
    document.execCommand('paste'); const text = field.value; field.remove(); return text;
  })()`);
  assert.equal(copied, selection.replace(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/g, ' '));
  console.log('PASS: PDF renders, has selectable text, and copied text has line breaks replaced by spaces');
} finally { await browser?.close(); server.close(); }
