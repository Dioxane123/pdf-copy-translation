import { applyModelPreset, buildModelParameters, gptCapabilities, normalizeModelSettings } from './model-presets.mjs';

const $ = (id) => document.getElementById(id);
let current;
async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ target: 'background', type, ...extra });
  if (!result || result.error) throw new Error(result?.error || '后台服务没有响应。');
  return result;
}
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function providerChanged() {
  $('model-fields').hidden = $('provider').value !== 'model';
  $('google-note').hidden = $('provider').value !== 'google';
  // Hidden model settings must not block saving Google settings with form validation.
  for (const field of $('model-fields').querySelectorAll('input, select')) field.disabled = $('provider').value !== 'model';
  renderParameters();
}
function modelFields() {
  return {
    model: $('model').value, modelPreset: $('model-preset').value,
    gptOptions: { reasoningEffort: $('gpt-effort').value, serviceTier: $('gpt-service-tier').value, verbosity: $('gpt-verbosity').value },
    deepseekOptions: { thinking: $('deepseek-thinking').value, reasoningEffort: $('deepseek-effort').value },
    maxOutputTokens: $('max-output-tokens').value, timeoutSeconds: $('timeout-seconds').value,
  };
}
function renderParameters() {
  const fields = modelFields();
  $('gpt-options').hidden = fields.modelPreset !== 'gpt';
  $('deepseek-options').hidden = fields.modelPreset !== 'deepseek';
  $('deepseek-effort').disabled = $('provider').value !== 'model' || fields.deepseekOptions.thinking === 'disabled';
  const capabilities = gptCapabilities(fields.model);
  for (const option of $('gpt-effort').options) option.disabled = option.value !== 'inherit' && !capabilities.efforts.includes(option.value);
  $('gpt-capabilities').textContent = capabilities.known
    ? `该型号支持：${capabilities.efforts.join(' / ')}。${capabilities.efforts.includes('none') ? 'none 表示关闭推理。' : '此型号不能完全关闭推理。'}`
    : '使用模型别名或其他型号时，请按服务商文档选择；不同 GPT 型号不一定支持全部档位。';
  $('deepseek-compatibility').textContent = /deepseek-(chat|reasoner)$/i.test(fields.model)
    ? '这是历史模型别名，中转站的实现可能不同。不支持新参数时请选择服务默认值；关闭思考后不会发送推理强度。'
    : '适用于当前 DeepSeek 模型。关闭思考后不发送推理强度；选择明确的强度会启用思考。没有单独的“速度”参数，优先速度时可关闭思考或选择 low。';
  try {
    $('model-parameters-preview').textContent = JSON.stringify(buildModelParameters(fields), null, 2);
    $('model-parameter-error').textContent = '';
  } catch (error) {
    $('model-parameters-preview').textContent = '请先修正参数。';
    $('model-parameter-error').textContent = error.message;
  }
}
function updateSuggestions() {
  const list = $('model-suggestions'); list.replaceChildren();
  const names = $('model-preset').value === 'gpt' ? ['gpt-6.1-sol', 'gpt-6-astra']
    : $('model-preset').value === 'deepseek' ? ['deepseek-flash', 'deepseek-v4-pro'] : [];
  for (const name of names) { const option = document.createElement('option'); option.value = name; list.append(option); }
}
function showVault() {
  $('vault-section').hidden = !current.hasKey;
  $('vault-status').textContent = current.unlocked ? '本次会话已解锁。' : '已加密保存，当前已锁定。';
  $('unlock-button').disabled = current.unlocked;
  $('unlock-password').disabled = current.unlocked;
  $('lock').disabled = !current.unlocked;
}
function fill() {
  $('translation-enabled').checked = current.settings.enabled;
  $('provider').value = current.settings.provider;
  $('target').value = current.settings.target;
  $('base-url').value = current.settings.baseUrl;
  $('model').value = current.settings.model;
  const parameters = normalizeModelSettings(current.settings);
  $('model-preset').value = parameters.modelPreset;
  $('gpt-effort').value = parameters.gptOptions.reasoningEffort;
  $('gpt-service-tier').value = parameters.gptOptions.serviceTier;
  $('gpt-verbosity').value = parameters.gptOptions.verbosity;
  $('deepseek-thinking').value = parameters.deepseekOptions.thinking;
  $('deepseek-effort').value = parameters.deepseekOptions.reasoningEffort;
  $('max-output-tokens').value = parameters.maxOutputTokens ?? '';
  $('timeout-seconds').value = parameters.timeoutSeconds;
  updateSuggestions();
  providerChanged(); showVault();
}
async function action(operation) {
  try { await operation(); }
  catch (error) { message(error.message, true); }
  finally { for (const id of ['api-key', 'save-password', 'unlock-password']) $(id).value = ''; }
}
$('provider').addEventListener('change', providerChanged);
$('model-preset').addEventListener('change', () => {
  const updated = applyModelPreset({ baseUrl: $('base-url').value, model: $('model').value }, $('model-preset').value);
  $('base-url').value = updated.baseUrl;
  $('model').value = updated.model;
  updateSuggestions(); renderParameters();
});
for (const id of ['model', 'gpt-effort', 'gpt-service-tier', 'gpt-verbosity', 'deepseek-thinking', 'deepseek-effort', 'max-output-tokens', 'timeout-seconds']) {
  $(id).addEventListener('input', renderParameters);
  $(id).addEventListener('change', renderParameters);
}
$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  void action(async () => {
    current = await send('translation-save', {
      settings: { enabled: $('translation-enabled').checked, provider: $('provider').value, target: $('target').value, baseUrl: $('base-url').value, ...modelFields() },
      apiKey: $('api-key').value, password: $('save-password').value,
    });
    fill(); message('已保存。返回 PDF 阅读模式后立即生效。');
  }).finally(() => { button.disabled = false; });
});
$('unlock-form').addEventListener('submit', (event) => {
  event.preventDefault(); $('unlock-button').disabled = true;
  void action(async () => { current = await send('translation-unlock', { password: $('unlock-password').value }); showVault(); message('已解锁，可返回 PDF 继续翻译。'); }).finally(() => showVault());
});
$('lock').addEventListener('click', () => void action(async () => { current = await send('translation-lock'); showVault(); message('已锁定，内存中的密钥已清除。'); }));
$('delete-key').addEventListener('click', () => void action(async () => {
  if (!confirm('删除已保存的 API_KEY？之后需要重新输入。')) return;
  current = await send('translation-delete-key'); showVault(); message('密钥已删除。');
}));
send('translation-settings').then((result) => { current = result; fill(); }).catch((error) => message(error.message, true));
