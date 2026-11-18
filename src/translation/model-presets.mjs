// Chat Completions parameter schemas checked against vendor docs on 2026-10-23.
// Presets are selected explicitly: a proxy's hostname does not identify its models.
export const MODEL_PRESETS = Object.freeze({
  custom: { label: '通用兼容接口', baseUrl: '', model: '' },
  gpt: { label: 'GPT', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
});
export const GPT_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_MODEL_SETTINGS = Object.freeze({
  modelPreset: 'custom',
  gptOptions: Object.freeze({ reasoningEffort: 'inherit', serviceTier: 'inherit', verbosity: 'inherit' }),
  deepseekOptions: Object.freeze({ thinking: 'inherit', reasoningEffort: 'inherit' }),
  maxOutputTokens: null,
  timeoutSeconds: 25,
});

function choice(value, fallback, allowed, label) {
  const selected = value ?? fallback;
  if (!allowed.includes(selected)) throw new Error(`${label}的值无效。`);
  return selected;
}
function integer(value, fallback, min, max, label) {
  if (value === null || value === undefined || value === '') return fallback;
  if (!['number', 'string'].includes(typeof value)) throw new Error(`${label}必须是整数。`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label}必须是 ${min}–${max} 之间的整数。`);
  return number;
}

export function normalizeModelSettings(input = {}) {
  return {
    modelPreset: choice(input.modelPreset, 'custom', Object.keys(MODEL_PRESETS), '模型模板'),
    gptOptions: {
      reasoningEffort: choice(input.gptOptions?.reasoningEffort, 'inherit', ['inherit', ...GPT_EFFORTS], 'GPT 推理强度'),
      serviceTier: choice(input.gptOptions?.serviceTier, 'inherit', ['inherit', 'auto', 'default', 'priority', 'fast', 'flex'], 'GPT 处理档位'),
      verbosity: choice(input.gptOptions?.verbosity, 'inherit', ['inherit', 'low', 'medium', 'high'], 'GPT 回答详细程度'),
    },
    deepseekOptions: {
      thinking: choice(input.deepseekOptions?.thinking, 'inherit', ['inherit', 'enabled', 'disabled'], 'DeepSeek 思考模式'),
      reasoningEffort: choice(input.deepseekOptions?.reasoningEffort, 'inherit', ['inherit', 'low', 'high', 'max'], 'DeepSeek 推理强度'),
    },
    maxOutputTokens: integer(input.maxOutputTokens, null, 1, 1048576, '输出 Token 上限'),
    timeoutSeconds: integer(input.timeoutSeconds, 25, 10, 180, '等待上限'),
  };
}

export function applyModelPreset(input, preset) {
  if (!Object.hasOwn(MODEL_PRESETS, preset)) throw new Error('模型模板无效。');
  const template = MODEL_PRESETS[preset];
  return {
    ...input,
    modelPreset: preset,
    // Only fill empty fields. Never redirect a configured proxy or replace an alias.
    baseUrl: input.baseUrl?.trim() ? input.baseUrl : template.baseUrl,
    model: input.model?.trim() ? input.model : template.model,
  };
}

export function gptCapabilities(model) {
  const name = String(model || '').toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const known = {
    'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-5.1': ['none', 'low', 'medium', 'high'],
    'gpt-5': ['minimal', 'low', 'medium', 'high'],
  };
  const matched = Object.hasOwn(known, name);
  return { known: matched, efforts: matched ? known[name] : GPT_EFFORTS };
}

export function buildModelParameters(input) {
  const settings = normalizeModelSettings(input);
  const parameters = {};
  if (settings.modelPreset === 'gpt') {
    const { reasoningEffort, serviceTier, verbosity } = settings.gptOptions;
    if (reasoningEffort !== 'inherit') {
      if (!gptCapabilities(input.model).efforts.includes(reasoningEffort)) {
        throw new Error(`${input.model} 不支持 ${reasoningEffort} 推理强度，请选择支持的档位或使用服务默认值。`);
      }
      parameters.reasoning_effort = reasoningEffort;
    }
    if (serviceTier !== 'inherit') parameters.service_tier = serviceTier;
    if (verbosity !== 'inherit') parameters.verbosity = verbosity;
  } else if (settings.modelPreset === 'deepseek') {
    const { thinking, reasoningEffort } = settings.deepseekOptions;
    if (thinking !== 'inherit') parameters.thinking = { type: thinking };
    // Do not inadvertently turn thinking back on with a retained effort setting.
    if (thinking !== 'disabled' && reasoningEffort !== 'inherit') parameters.reasoning_effort = reasoningEffort;
  }
  if (settings.maxOutputTokens !== null) {
    parameters[settings.modelPreset === 'gpt' ? 'max_completion_tokens' : 'max_tokens'] = settings.maxOutputTokens;
  }
  return parameters;
}
