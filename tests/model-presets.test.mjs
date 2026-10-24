import test from 'node:test';
import assert from 'node:assert/strict';
import { applyModelPreset, buildModelParameters, gptCapabilities, normalizeModelSettings } from '../model-presets.mjs';
import { validateSettings, translateText } from '../translation.mjs';

const modelSettings = (extra = {}) => ({ enabled: true, provider: 'model', target: 'zh-CN', baseUrl: 'https://proxy.example.org/custom/v1', model: 'proxy-model-alias', ...extra });

test('upgrading old settings preserves wire format and 25 second timeout', () => {
  const settings = validateSettings(modelSettings());
  assert.equal(settings.modelPreset, 'custom');
  assert.equal(settings.timeoutSeconds, 25);
  assert.deepEqual(buildModelParameters(settings), {});
});

test('preset selection preserves custom URLs and aliases and only fills empty fields', () => {
  for (const preset of ['gpt', 'deepseek']) {
    const old = modelSettings();
    const selected = applyModelPreset(old, preset);
    assert.equal(selected.baseUrl, old.baseUrl);
    assert.equal(selected.model, old.model);
    assert.equal(old.modelPreset, undefined);
    const empty = applyModelPreset({ baseUrl: '', model: '' }, preset);
    assert.match(empty.baseUrl, /^https:/);
    assert.ok(empty.model);
  }
  assert.throws(() => applyModelPreset({}, '__proto__'));
});

test('GPT uses Chat Completions fields, not Responses fields or SDK extra_body', () => {
  assert.deepEqual(buildModelParameters(modelSettings({ modelPreset: 'gpt', gptOptions: { reasoningEffort: 'low', serviceTier: 'priority', verbosity: 'low' }, maxOutputTokens: '4096' })), {
    reasoning_effort: 'low', service_tier: 'priority', verbosity: 'low', max_completion_tokens: 4096,
  });
});

test('known GPT model capability checks distinguish off from minimal and reject unsupported effort', () => {
  assert.ok(gptCapabilities('gpt-5.1').efforts.includes('none'));
  assert.ok(!gptCapabilities('gpt-5').efforts.includes('none'));
  assert.ok(gptCapabilities('gpt-5').efforts.includes('minimal'));
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-sol-2026-10-01']) {
    for (const reasoningEffort of ['none', 'minimal']) assert.throws(() => buildModelParameters(modelSettings({ model, modelPreset: 'gpt', gptOptions: { reasoningEffort } })), /不支持/);
    assert.equal(buildModelParameters(modelSettings({ model, modelPreset: 'gpt', gptOptions: { reasoningEffort: 'max' } })).reasoning_effort, 'max');
  }
  assert.equal(buildModelParameters(modelSettings({ model: 'gpt-5.1', modelPreset: 'gpt', gptOptions: { reasoningEffort: 'none' } })).reasoning_effort, 'none');
  assert.equal(buildModelParameters(modelSettings({ modelPreset: 'gpt', gptOptions: { reasoningEffort: 'none' } })).reasoning_effort, 'none');
  for (const model of ['constructor', '__proto__']) assert.ok(Array.isArray(gptCapabilities(model).efforts));
});

test('default omits optional fields; explicit auto and standard remain meaningful', () => {
  assert.deepEqual(buildModelParameters({ modelPreset: 'gpt' }), {});
  assert.deepEqual(buildModelParameters({ modelPreset: 'gpt', gptOptions: { serviceTier: 'auto' } }), { service_tier: 'auto' });
  assert.deepEqual(buildModelParameters({ modelPreset: 'gpt', gptOptions: { serviceTier: 'default' } }), { service_tier: 'default' });
  assert.deepEqual(buildModelParameters({ modelPreset: 'gpt', gptOptions: { serviceTier: 'fast' } }), { service_tier: 'fast' });
});

test('DeepSeek thinking is a top-level object and strength is omitted when off', () => {
  assert.deepEqual(buildModelParameters({ modelPreset: 'deepseek', deepseekOptions: { thinking: 'enabled', reasoningEffort: 'max' }, maxOutputTokens: 8192 }), {
    thinking: { type: 'enabled' }, reasoning_effort: 'max', max_tokens: 8192,
  });
  assert.deepEqual(buildModelParameters({ modelPreset: 'deepseek', deepseekOptions: { thinking: 'disabled', reasoningEffort: 'max' } }), { thinking: { type: 'disabled' } });
  assert.deepEqual(buildModelParameters({ modelPreset: 'deepseek', deepseekOptions: { thinking: 'inherit', reasoningEffort: 'low' } }), { reasoning_effort: 'low' });
});

test('switching presets never leaks the other vendor fields', () => {
  const settings = { gptOptions: { reasoningEffort: 'max', serviceTier: 'priority', verbosity: 'high' }, deepseekOptions: { thinking: 'enabled', reasoningEffort: 'high' } };
  assert.deepEqual(buildModelParameters({ ...settings, modelPreset: 'custom' }), {});
  assert.deepEqual(buildModelParameters({ ...settings, modelPreset: 'gpt' }), { reasoning_effort: 'max', service_tier: 'priority', verbosity: 'high' });
  assert.deepEqual(buildModelParameters({ ...settings, modelPreset: 'deepseek' }), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
});

test('invalid enums and token/time budgets are rejected', () => {
  for (const input of [
    { modelPreset: '__proto__' }, { gptOptions: { reasoningEffort: 'ultra' } },
    { gptOptions: { serviceTier: 'unknown' } }, { deepseekOptions: { thinking: true } },
    { deepseekOptions: { reasoningEffort: 'medium' } }, { maxOutputTokens: 0 },
    { maxOutputTokens: 1.5 }, { maxOutputTokens: true }, { timeoutSeconds: 181 }, { timeoutSeconds: 0 },
  ]) assert.throws(() => normalizeModelSettings(input));
});

test('extra parameters travel to the custom endpoint while credentials and translation contract stay intact', async () => {
  for (const modelPreset of ['gpt', 'deepseek']) {
    const settings = modelSettings({ modelPreset, gptOptions: { reasoningEffort: 'low', serviceTier: 'fast' }, deepseekOptions: { thinking: 'enabled', reasoningEffort: 'high' }, maxOutputTokens: 4096 });
    let request;
    const output = await translateText({ text: 'Hello', apiKey: 'test-secret', settings, fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '你好', reasoning_content: 'not the translation' }, finish_reason: 'stop' }] }));
    } });
    assert.equal(output, '你好');
    assert.equal(request.url, 'https://proxy.example.org/custom/v1/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer test-secret');
    assert.equal(request.body.model, 'proxy-model-alias');
    assert.equal(request.body.stream, false);
    assert.equal(request.body.messages[1].content, 'Hello');
    assert.equal(request.body.extra_body, undefined);
    assert.equal(request.body.reasoning, undefined);
    for (const [key, value] of Object.entries(buildModelParameters(settings))) assert.deepEqual(request.body[key], value);
  }
});

test('reasoning budget exhaustion is never presented as a complete translation', async () => {
  await assert.rejects(translateText({ text: 'Hello', apiKey: 'test-secret', settings: modelSettings(), fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'incomplete', reasoning_content: 'private reasoning' }, finish_reason: 'length' }] })) }), /上限/);
});

test('a provider rejection does not silently retry and change the chosen reasoning settings', async () => {
  let attempts = 0;
  await assert.rejects(translateText({ text: 'Hello', apiKey: 'test-secret', settings: modelSettings({ modelPreset: 'gpt' }), fetchImpl: async () => {
    attempts++; return new Response('sensitive provider diagnostic', { status: 400 });
  } }), error => error.message.includes('额外参数') && !error.message.includes('sensitive'));
  assert.equal(attempts, 1);
});
