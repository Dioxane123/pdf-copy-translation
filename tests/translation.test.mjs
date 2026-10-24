import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptApiKey, decryptApiKey } from '../crypto.mjs';
import { normalizeEndpoint, translateText, validateSettings, DEFAULT_TRANSLATION } from '../translation.mjs';

test('encrypted keys decrypt only with the correct password and endpoint', async () => {
  const endpoint = 'https://example.org/v1/chat/completions';
  const secret = 'test-only-api-key';
  const vault = await encryptApiKey(secret, 'a-test-password', endpoint);
  assert.ok(!JSON.stringify(vault).includes(secret));
  assert.equal(await decryptApiKey(vault, 'a-test-password', endpoint), secret);
  await assert.rejects(decryptApiKey(vault, 'wrong-password', endpoint), /解锁失败/);
  await assert.rejects(decryptApiKey(vault, 'a-test-password', 'https://other.example.org'), /不匹配/);
  const bytes = Uint8Array.from(atob(vault.ciphertext), c => c.charCodeAt(0));
  bytes[0] ^= 1;
  const altered = { ...vault, ciphertext: btoa(String.fromCharCode(...bytes)) };
  await assert.rejects(decryptApiKey(altered, 'a-test-password', endpoint), /解锁失败/);
  const second = await encryptApiKey(secret, 'a-test-password', endpoint);
  assert.notEqual(second.ciphertext, vault.ciphertext);
});

test('normalizes model endpoints and rejects insecure or credential-bearing URLs', () => {
  assert.equal(normalizeEndpoint('https://example.org/v1/'), 'https://example.org/v1/chat/completions');
  assert.equal(normalizeEndpoint('https://example.org/v1/chat/completions'), 'https://example.org/v1/chat/completions');
  assert.equal(normalizeEndpoint('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1/chat/completions');
  for (const value of ['http://example.org', 'https://user:password@example.org', 'https://example.org?key=secret', 'file:///tmp/api', 'not a url']) assert.throws(() => normalizeEndpoint(value));
});

test('model request uses the configured endpoint and never follows redirects or sends cookies', async () => {
  const settings = validateSettings({ enabled: true, provider: 'model', target: 'zh-CN', baseUrl: 'https://example.org/v1', model: 'translator-model' });
  let request;
  const translation = await translateText({ text: 'Hello\nworld', settings, apiKey: 'test-key', fetchImpl: async (url, options) => {
    request = { url, options }; return new Response(JSON.stringify({ choices: [{ message: { content: '你好，世界。' } }] }));
  } });
  assert.equal(translation, '你好，世界。');
  assert.equal(request.url, 'https://example.org/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.credentials, 'omit');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'translator-model');
  assert.deepEqual(body.messages[1], { role: 'user', content: 'Hello\nworld' });
  assert.equal(body.stream, false);
});

test('Google request auto-detects language and joins translated segments', async () => {
  let request;
  const translation = await translateText({ text: 'First. Second.', settings: DEFAULT_TRANSLATION, fetchImpl: async (url, options) => {
    request = { url, options }; return new Response(JSON.stringify([[['第一。', 'First.'], ['第二。', 'Second.']], null, 'en']));
  } });
  assert.equal(translation, '第一。第二。');
  assert.equal(new URLSearchParams(request.options.body).get('sl'), 'auto');
  assert.equal(new URLSearchParams(request.options.body).get('tl'), 'zh-CN');
  assert.equal(request.options.headers.Authorization, undefined);
});

test('remote failures never expose response bodies or credentials', async () => {
  await assert.rejects(translateText({ text: 'Hello', settings: DEFAULT_TRANSLATION, fetchImpl: async () => new Response('private-key-from-provider', { status: 401 }) }), error => /401/.test(error.message) && !error.message.includes('private-key'));
  await assert.rejects(translateText({ text: 'Hello', settings: DEFAULT_TRANSLATION, fetchImpl: async () => new Response('{}') }), /没有返回译文/);
  await assert.rejects(translateText({ text: 'Hello', settings: { ...DEFAULT_TRANSLATION, provider: 'model' }, apiKey: '' }), /锁定/);
});

test('rejects empty, oversized and invalid requests before any network access', async () => {
  const fetchImpl = () => { throw new Error('unexpected network'); };
  for (const text of ['', '  ', 'x'.repeat(12001)]) await assert.rejects(translateText({ text, settings: DEFAULT_TRANSLATION, fetchImpl }));
  assert.throws(() => validateSettings({ ...DEFAULT_TRANSLATION, provider: 'invalid' }));
  assert.throws(() => validateSettings({ ...DEFAULT_TRANSLATION, target: 'invalid' }));
});
