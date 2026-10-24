import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, rm } from 'node:fs/promises';
import { launchBrowser, until, delay, makePdf } from './browser-harness.mjs';

let requestCount = 0;
let apiDelay = 80;
let apiError = false;
const requests = [];
const server = createServer(async (req, res) => {
  if (req.url === '/document.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(makePdf()); return; }
  if (req.url === '/v1/chat/completions') {
    let text = ''; for await (const chunk of req) text += chunk;
    const data = JSON.parse(text); requestCount++;
    assert.equal(req.headers.authorization, 'Bearer test-api-key-not-real');
    requests.push(data);
    await delay(apiDelay);
    res.writeHead(apiError ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(apiError ? { error: 'must-not-display-secret' } : { choices: [{ message: { content: data.messages[1].content.includes('Beta') ? '这是第二行的译文。' : '这是第一行的译文。' } }] })); return;
  }
  res.writeHead(404); res.end();
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();
const { evaluate, send, page, shortcut, origin } = browser;
const localPdf = '/tmp/pdf-translation-smoke.pdf';
try {
  const options = await page(`${origin}/options.html`);
  await until(() => evaluate(options.session, "document.getElementById('provider').value === 'google'"), 'settings ready');
  await evaluate(options.session, `(() => {
    document.getElementById('translation-enabled').checked = true;
    document.getElementById('provider').value = 'model';
    document.getElementById('provider').dispatchEvent(new Event('change'));
    document.getElementById('base-url').value = ${JSON.stringify(base + '/v1')};
    document.getElementById('model').value = 'test-model';
    document.getElementById('api-key').value = 'test-api-key-not-real';
    document.getElementById('save-password').value = 'test-unlock-password';
    document.querySelector('#settings-form button[type=submit]').click();
  })()`);
  await until(() => evaluate(options.session, "document.getElementById('message').textContent.includes('已保存')"), 'save encrypted settings');
  const persisted = await evaluate(options.session, 'chrome.storage.local.get(null)');
  assert.ok(!JSON.stringify(persisted).includes('test-api-key-not-real'));
  assert.ok(!JSON.stringify(persisted).includes('test-unlock-password'));
  assert.equal(persisted.translationVault.version, 1);
  console.log('PASS: settings save encrypted credentials without persisting plaintext or password');

  const reader = await page(`${origin}/pdfjs/web/viewer.html?file=&source=${encodeURIComponent(base + '/document.pdf')}`);
  await send('Target.activateTarget', { targetId: reader.targetId });
  await until(() => evaluate(reader.session, "document.querySelectorAll('.textLayer span').length >= 2"), 'PDF text layer', 25000);
  assert.equal(await evaluate(reader.session, "PDFViewerApplicationOptions.get('enableScripting')"), false);
  assert.equal(await evaluate(reader.session, "PDFViewerApplicationOptions.get('enableWebGPU')"), false);
  const select = async (which = 0) => evaluate(reader.session, `(() => {
    document.activeElement?.blur();
    const span = Array.from(document.querySelectorAll('.textLayer span')).filter(x => x.textContent.trim())[${which}];
    const range = document.createRange(); range.selectNodeContents(span);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return selection.toString();
  })()`);
  const clear = () => evaluate(reader.session, 'getSelection().removeAllRanges()');
  const hidden = () => evaluate(reader.session, "document.getElementById('translation-card').hidden");
  const content = () => evaluate(reader.session, "document.getElementById('translation-result').textContent");
  const click = async selector => {
    const point = await evaluate(reader.session, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }, reader.session);
  };
  const copy = async which => { await select(which); await shortcut(reader.session, 'c'); };
  const paste = () => evaluate(options.session, `(() => { const f = document.createElement('textarea'); document.body.append(f); f.focus(); document.execCommand('paste'); const text = f.value; f.remove(); return text; })()`);
  await copy(0);
  await until(async () => (await content()) === '这是第一行的译文。', 'translation result');
  assert.ok((await paste()).includes('Alpha first line'));
  assert.equal(await evaluate(reader.session, "document.getElementById('translation-card').contains(document.activeElement)"), false);
  console.log('PASS: real copy shows a translation without stealing focus or replacing original clipboard');
  await clear(); await until(hidden, 'deselect hides card');
  console.log('PASS: clearing original selection hides translation');

  await copy(0); await until(async () => (await content()) === '这是第一行的译文。', 'repeat copy');
  await click('#translation-result'); await clear(); await delay(150);
  assert.equal(await hidden(), false);
  assert.equal(await evaluate(reader.session, "document.getElementById('translation-retained').hidden"), false);
  const countBeforeTranslationCopy = requestCount;
  await evaluate(reader.session, `(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('translation-result')); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
  await shortcut(reader.session, 'c'); await delay(150);
  assert.equal(await paste(), '这是第一行的译文。');
  assert.equal(requestCount, countBeforeTranslationCopy);
  await click('#reader-mode-status'); await clear(); await until(hidden, 'outside click hides retained card');
  console.log('PASS: clicking/selecting translation retains it; copying translation does not retrigger; outside click closes it');

  apiDelay = 900;
  await copy(0); await until(async () => !(await hidden()), 'loading card');
  await clear(); await until(hidden, 'cancel pending translation'); await delay(1100);
  assert.equal(await hidden(), true);
  console.log('PASS: a late response does not reopen a dismissed card');
  await copy(0); await delay(100); await copy(1);
  await until(async () => (await content()) === '这是第二行的译文。', 'latest selection result');
  await delay(400); assert.equal(await content(), '这是第二行的译文。');
  console.log('PASS: fast repeated copies keep only the newest translation');

  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, reader.session);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, reader.session);
  await until(hidden, 'Escape closes card');
  await evaluate(reader.session, `(() => {
    const spans = Array.from(document.querySelectorAll('.textLayer span')).filter(x => x.textContent.trim());
    const r = document.createRange(); r.setStart(spans[0].firstChild, 0); r.setEnd(spans[1].firstChild, spans[1].textContent.length);
    getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy');
  })()`);
  await until(async () => (await content()) === '这是第二行的译文。', 'multi-line copy');
  const multilineCopy = await paste();
  assert.ok(multilineCopy.includes('Alpha first line'));
  assert.ok(multilineCopy.includes('Beta second line'));
  assert.ok(!/[\r\n]/.test(multilineCopy));
  assert.match(multilineCopy, /line +Beta/);
  console.log('PASS: Escape closes the card and multi-line copy preserves words separated by spaces');

  apiDelay = 80; apiError = true;
  await copy(0); await until(async () => (await content()).includes('401'), 'provider error');
  assert.ok(!(await content()).includes('must-not-display-secret'));
  assert.equal(await evaluate(reader.session, "document.getElementById('translation-retry').hidden"), false);
  apiError = false; await click('#translation-retry');
  await until(async () => (await content()) === '这是第一行的译文。', 'retry');
  console.log('PASS: provider errors are safe and retry works');

  await evaluate(options.session, "document.getElementById('lock').click()");
  await until(() => evaluate(options.session, "document.getElementById('vault-status').textContent.includes('当前已锁定')"), 'vault lock');
  await copy(0); await until(async () => (await content()).includes('已锁定'), 'locked API feedback');
  await evaluate(options.session, "document.getElementById('unlock-password').value='wrong-password'; document.getElementById('unlock-button').click()");
  await until(() => evaluate(options.session, "document.getElementById('message').textContent.includes('解锁失败')"), 'bad password');
  await evaluate(options.session, "document.getElementById('unlock-password').value='test-unlock-password'; document.getElementById('unlock-button').click()");
  await until(() => evaluate(options.session, "document.getElementById('vault-status').textContent.includes('已解锁')"), 'unlock');
  await copy(0); await until(async () => (await content()) === '这是第一行的译文。', 'translation after unlock');
  console.log('PASS: lock, wrong password rejection, unlock and resume');

  // Screenshot contains only generated sample text and simulated translations.
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }, reader.session);
  await writeFile(new URL('../reader-preview.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
  await writeFile(localPdf, makePdf());
  const dom = await send('DOM.getDocument', {}, reader.session);
  const fileInput = await send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#fileInput' }, reader.session);
  await send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [localPdf] }, reader.session);
  await delay(500);
  await until(() => evaluate(reader.session, "document.querySelectorAll('.textLayer span').length >= 2"), 'local PDF');
  await copy(1); await until(async () => (await content()) === '这是第二行的译文。', 'local PDF translation');
  console.log('PASS: local PDF file picker and copy translation');
  await evaluate(reader.session, `(() => {
    PDFViewerApplication.pdfDocument.getPermissions = async () => new Set([16]);
    PDFViewerApplication.eventBus.dispatch('documentloaded');
  })()`);
  await delay(100); await copy(0); await until(async () => (await content()) === '这是第一行的译文。', 'allowed PDF permission set');
  await evaluate(reader.session, `(() => {
    PDFViewerApplication.pdfDocument.getPermissions = async () => new Set([]);
    PDFViewerApplication.eventBus.dispatch('documentloaded');
  })()`);
  await delay(100);
  const countBeforeRestrictedCopy = requestCount;
  await copy(0); await delay(300);
  assert.equal(requestCount, countBeforeRestrictedCopy);
  assert.equal(await hidden(), true);
  console.log('PASS: PDF permission sets allow permitted copies and suppress restricted translation');
  const errors = browser.events.filter(event => event.method === 'Runtime.exceptionThrown');
  assert.deepEqual(errors, []);
  console.log('PASS: no unhandled browser exceptions');
} catch (error) {
  console.error(JSON.stringify(browser.events, null, 2));
  throw error;
} finally { await browser.close(); server.close(); await rm(localPdf, {force:true}); }
