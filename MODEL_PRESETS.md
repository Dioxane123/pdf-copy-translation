# GPT 与 DeepSeek 参数调研及实现

核对日期：**2026-10-23**。本扩展使用 `/chat/completions`，以下字段均对应 Chat Completions 请求；不能直接套用 Responses API 的嵌套字段。

## GPT

GPT 使用 `reasoning_effort` 控制思考量，可选档位因型号而异。扩展提供 `none / minimal / low / medium / high / xhigh / max`，以及不发送字段的默认选项。`none` 才是关闭推理；`minimal` 仍包含推理。降低强度通常减少延迟及推理 Token。[OpenAI 推理指南](https://developers.openai.com/api/docs/guides/reasoning?api-mode=chat)

已加入明确型号的校验：

| 官方型号（包括日期快照后缀） | 可用推理档位 |
| --- | --- |
| GPT-6 Astra | low / medium / high / xhigh / max |
| GPT-6.1 Sol | low / medium / high / xhigh / max |
| GPT-5.1 | none / low / medium / high |
| GPT-5 | minimal / low / medium / high |

依据：[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[GPT-5.1](https://developers.openai.com/api/docs/models/gpt-5.1)、[GPT-5](https://developers.openai.com/api/docs/models/gpt-5)。历史型号是否仍可调用，应以所用服务的实际情况为准。其他型号或中转站别名不自动套用这些限制。

`service_tier` 选择处理档位，和推理强度是两个独立维度。模板支持标准、项目默认、Flex、Priority 和 Fast。官方将 Fast 与 Priority 请求归入优先处理；响应中的实际档位可能与请求值不同。`verbosity` 控制输出详细程度。`max_completion_tokens` 包含可见输出及推理 Token。[OpenAI Chat Completions 参数参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

模板不自动填写 temperature / top_p，不把某些版本不支持的采样参数加入请求。所有额外字段默认省略，也不会默认开启更高计费的处理档位。

示例（密钥放在 Authorization 请求头，不在参数预览中展示）：

```json
{
  "model": "gpt-6.1-sol",
  "reasoning_effort": "low",
  "service_tier": "priority",
  "verbosity": "low",
  "max_completion_tokens": 4096,
  "stream": false,
  "messages": [
    {"role": "system", "content": "Translate into Simplified Chinese. Return only the translation."},
    {"role": "user", "content": "Hello world."}
  ]
}
```

## DeepSeek

当前官方模型表列出 `deepseek-flash` 和 `deepseek-v4-pro`，支持思考与非思考模式；模板保留可编辑的模型名，方便使用中转站映射。[DeepSeek 模型说明](https://api-docs.deepseek.com/quick_start/pricing/)

思考开关使用顶层 `thinking.type = enabled / disabled`，强度使用 `reasoning_effort = low / high / max`。明确的强度值可以启用思考，因此关闭思考时扩展省略强度字段。界面不提供未在官方文档定义的独立速度参数；希望更快时可关闭思考或选择 low。[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)

思考模式下 temperature 等采样设置可能无效，top_p 的行为也依型号而异，所以此模板不添加它们。只显示最终 `content`，不将 `reasoning_content` 当成译文。[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)

关闭思考的请求示例：

```json
{
  "model": "deepseek-flash",
  "thinking": {"type": "disabled"},
  "max_tokens": 4096,
  "stream": false,
  "messages": [
    {"role": "system", "content": "Translate into Simplified Chinese. Return only the translation."},
    {"role": "user", "content": "Hello world."}
  ]
}
```

开启思考时可改为 `"thinking":{"type":"enabled"}`，并添加 `"reasoning_effort":"high"`。这里是原始 HTTP JSON；文档 Python SDK 示例中的 `extra_body` 是 SDK 扩展参数容器，不能照搬成请求体的一层。[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)

DeepSeek 使用 `max_tokens` 控制输出预算；预算耗尽可返回 `finish_reason: "length"`。扩展对此显示重试建议，避免展示不完整的译文。[DeepSeek Chat Completions 参考](https://api-docs.deepseek.com/api/create-chat-completion/)

## 中转站和升级兼容

- 预设只选择字段格式，所有请求始终发送到用户填写的 Base URL，不会改发官方地址。
- 切换模板仅补全空白地址或模型名；已经填写的内容保留，始终可以修改。
- 地址不变时，切换模板无需重新加密 API_KEY；换地址时沿用既有规则，需重新输入并加密密钥。
- 额外字段分别记忆，只有当前模板的字段进入请求。通用模板仍使用原来的最简协议。
- 中转站不一定透传所有官方参数。遇到 400 / 422 会提示检查参数；扩展不会悄悄删除参数并重发付费请求。
- 等待上限是扩展本地控制，默认 25 秒，可调至 180 秒；仅在有请求期间维持后台活跃。取消选区、关闭文档或超时后停止请求。
- 旧配置自动使用通用模板，保持原有请求格式和加密密钥。

已验证设置界面及 HTTP 参数传递、配置持久化、原有浮窗行为和模拟慢请求。尚未使用真实付费模型或用户的中转站验证；这里的调研确认字段语义，实际支持程度仍由所用端点决定。
