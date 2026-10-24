import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { launchBrowser, until, delay, makePdf } from './browser-harness.mjs';

const requests = [];
let responseDelay = 0;
const server = createServer(async (req, res) => {
  if (req.url === '/document.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(makePdf()); return; }
  if (req.url === '/proxy/v1/chat/completions') {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ body: JSON.parse(body), authorization: req.headers.authorization });
    await delay(responseDelay);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '预设测试译文', reasoning_content: 'not shown' }, finish_reason: 'stop' }] })); return;
  }
  res.writeHead(404); res.end();
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();
const { page, send, evaluate, shortcut, origin } = browser;
try {
  const options = await page(`${origin}/options.html`);
  const set = async (id, value) => evaluate(options.session, `(() => {
    const field = document.getElementById(${JSON.stringify(id)});
    ${typeof value === 'boolean' ? `field.checked = ${value}` : `field.value = ${JSON.stringify(value)}`};
    field.dispatchEvent(new Event('input')); field.dispatchEvent(new Event('change'));
  })()`);
  const get = id => evaluate(options.session, `document.getElementById(${JSON.stringify(id)}).value`);
  const save = async () => {
    await evaluate(options.session, "document.getElementById('message').textContent=''; document.querySelector('#settings-form button[type=submit]').click()");
    await until(() => evaluate(options.session, "document.getElementById('message').textContent.includes('已保存')"), 'save settings');
  };
  await until(() => evaluate(options.session, "document.getElementById('provider').value === 'google'"), 'settings initialized');
  await set('translation-enabled', true); await set('provider', 'model');
  await set('base-url', base + '/proxy/v1'); await set('model', 'gateway-model-alias');
  await set('api-key', 'test-preset-key'); await set('save-password', 'test-preset-password');
  await save();
  const vault = await evaluate(options.session, 'chrome.storage.local.get("translationVault")');
  // Simulate upgrading settings saved by version 1.1.0 (no preset fields).
  await evaluate(options.session, `chrome.storage.local.set({translationSettings:{enabled:true,provider:'model',target:'zh-CN',baseUrl:${JSON.stringify(base + '/proxy/v1')},model:'gateway-model-alias'}})`);
  await send('Page.reload', {}, options.session);
  await until(async () => await get('model') === 'gateway-model-alias', 'legacy settings reload');
  assert.equal(await get('model-preset'), 'custom');
  assert.equal(await get('timeout-seconds'), '25');
  console.log('PASS: legacy settings open with compatible defaults');

  await set('model-preset', 'gpt');
  assert.equal(await get('base-url'), base + '/proxy/v1');
  assert.equal(await get('model'), 'gateway-model-alias');
  await set('gpt-effort', 'low'); await set('gpt-service-tier', 'fast'); await set('gpt-verbosity', 'low');
  await set('max-output-tokens', '4096'); await set('timeout-seconds', '60');
  await save();
  assert.deepEqual(await evaluate(options.session, 'chrome.storage.local.get("translationVault")'), vault);
  const reader = await page(`${origin}/pdfjs/web/viewer.html?file=&source=${encodeURIComponent(base + '/document.pdf')}`);
  await send('Target.activateTarget', { targetId: reader.targetId });
  await until(() => evaluate(reader.session, "document.querySelectorAll('.textLayer span').length >= 2"), 'PDF render');
  const copy = async () => {
    await evaluate(reader.session, `(() => {
      const span = Array.from(document.querySelectorAll('.textLayer span')).find(x=>x.textContent.trim());
      const range = document.createRange(); range.selectNodeContents(span);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    })()`);
    await shortcut(reader.session, 'c');
  };
  const translate = async () => {
    const count = requests.length;
    await copy();
    await until(() => requests.length > count, 'model request');
    await until(() => evaluate(reader.session, "document.getElementById('translation-result').textContent === '预设测试译文'"), 'translation', 45000);
    return requests.at(-1).body;
  };
  let body = await translate();
  assert.equal(body.model, 'gateway-model-alias');
  assert.equal(body.reasoning_effort, 'low'); assert.equal(body.service_tier, 'fast'); assert.equal(body.verbosity, 'low');
  assert.equal(body.max_completion_tokens, 4096); assert.equal(body.max_tokens, undefined); assert.equal(body.thinking, undefined);
  assert.equal(requests.at(-1).authorization, 'Bearer test-preset-key');
  console.log('PASS: GPT preset reaches the configured proxy with GPT fields and unchanged encrypted key');

  await set('model-preset', 'deepseek');
  assert.equal(await get('base-url'), base + '/proxy/v1'); assert.equal(await get('model'), 'gateway-model-alias');
  await set('deepseek-thinking', 'enabled'); await set('deepseek-effort', 'max'); await save();
  body = await translate();
  assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'max'); assert.equal(body.max_tokens, 4096);
  for (const field of ['service_tier', 'verbosity', 'max_completion_tokens', 'extra_body']) assert.equal(body[field], undefined);
  console.log('PASS: DeepSeek preset uses top-level thinking parameters without GPT fields');

  await set('deepseek-thinking', 'disabled');
  assert.equal(await evaluate(options.session, "document.getElementById('deepseek-effort').disabled"), true);
  await save(); body = await translate();
  assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.reasoning_effort, undefined);
  await send('Page.reload', {}, options.session);
  await until(async () => await get('model-preset') === 'deepseek', 'preset persistence');
  assert.equal(await get('deepseek-thinking'), 'disabled');
  assert.equal(await get('deepseek-effort'), 'max');
  assert.equal(await get('gpt-service-tier'), 'fast');
  assert.equal(await get('base-url'), base + '/proxy/v1');
  console.log('PASS: thinking-off suppresses effort and all preset settings survive reload');

  await set('model-preset', 'custom'); await set('max-output-tokens', ''); await save(); body = await translate();
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'stream']);
  console.log('PASS: switching back to generic sends the original minimal request');

  await set('model-preset', 'gpt'); await set('model', 'gpt-6.1-sol'); await set('gpt-effort', 'none');
  assert.equal(await evaluate(options.session, "document.querySelector('#gpt-effort option[value=none]').disabled"), true);
  assert.match(await evaluate(options.session, "document.getElementById('model-parameter-error').textContent"), /不支持/);
  await evaluate(options.session, "document.getElementById('message').textContent=''; document.querySelector('#settings-form button[type=submit]').click()");
  await until(() => evaluate(options.session, "document.getElementById('message').textContent.includes('不支持')"), 'unsupported effort rejected');
  await set('gpt-effort', 'low'); await save();
  await evaluate(options.session, "document.getElementById('model-preset').scrollIntoView(); document.getElementById('parameter-preview').open=true");
  const shot = await send('Page.captureScreenshot', { format: 'png' }, options.session);
  await writeFile(new URL('../presets-preview.png', import.meta.url), Buffer.from(shot.data, 'base64'));
  console.log('PASS: invalid known-model effort is explained and rejected before saving');

  responseDelay = 33000;
  const start = Date.now(); body = await translate();
  assert.ok(Date.now() - start >= 33000);
  assert.equal(body.reasoning_effort, 'low');
  responseDelay = 0;
  console.log('PASS: 60 second wait setting handles a 33 second model response without worker termination');
  const local = await evaluate(options.session, 'chrome.storage.local.get(null)');
  assert.ok(!JSON.stringify(local).includes('test-preset-key'));
  assert.ok(!JSON.stringify(local).includes('test-preset-password'));
  assert.deepEqual(browser.events.filter(e => e.method === 'Runtime.exceptionThrown'), []);
  console.log('PASS: credentials remain encrypted on disk and browser has no unhandled exceptions');
} catch (error) { console.error(JSON.stringify(browser.events, null, 2)); throw error; }
finally { await browser.close(); server.close(); }
