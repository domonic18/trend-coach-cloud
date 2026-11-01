import type { LlmConfig } from '../config.js'

export type LlmFailure = 'unavailable' | 'rate_limited' | 'invalid_response' | 'truncated' | 'input_too_large'

export class LlmError extends Error {
  constructor(readonly kind: LlmFailure) {
    super(`llm ${kind}`)
    this.name = 'LlmError'
  }
}

/** 只提取数字，provider 原始响应体不落库。 */
export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
}

export interface LlmRequest {
  system: string
  user: string
  signal?: AbortSignal
  onUsage?: (usage: LlmUsage) => void
}

export interface LlmClient {
  completeJson<T>(request: LlmRequest, parse: (value: unknown) => T): Promise<T>
}

/**
 * OpenAI 兼容走 /chat/completions，Anthropic 走 /v1/messages；
 * 两者都只接受 JSON 对象，拒绝截断输出。
 */
export function createLlmClient(config: LlmConfig): LlmClient {
  const anthropic = config.protocol === 'anthropic'
  const endpoint = anthropic
    ? `${config.baseUrl}/v1/messages`
    : `${config.baseUrl}/chat/completions`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiKey !== undefined) {
    headers.authorization = `Bearer ${config.apiKey}`
    if (anthropic) headers['x-api-key'] = config.apiKey
  }
  if (anthropic) headers['anthropic-version'] = '2023-06-01'

  return {
    async completeJson<T>(request: LlmRequest, parse: (value: unknown) => T): Promise<T> {
      if (request.system.length + request.user.length > config.maxInputChars) {
        throw new LlmError('input_too_large')
      }

      const signals = [AbortSignal.timeout(config.timeoutMs)]
      if (request.signal !== undefined) signals.push(request.signal)

      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(anthropic
            ? {
                model: config.model,
                temperature: config.temperature,
                max_tokens: config.maxTokens,
                system: request.system,
                messages: [{ role: 'user', content: request.user }],
              }
            : {
                model: config.model,
                temperature: config.temperature,
                max_tokens: config.maxTokens,
                response_format: { type: 'json_object' },
                messages: [
                  { role: 'system', content: request.system },
                  { role: 'user', content: request.user },
                ],
              }),
          signal: AbortSignal.any(signals),
        })
      } catch {
        throw new LlmError('unavailable')
      }

      if (response.status === 429) throw new LlmError('rate_limited')
      if (response.status >= 500) throw new LlmError('unavailable')
      if (!response.ok) throw new LlmError('invalid_response')

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new LlmError('invalid_response')
      }
      if (request.onUsage !== undefined) {
        const usage = extractUsage(payload, anthropic)
        if (usage !== undefined) request.onUsage(usage)
      }
      const content = anthropic ? extractAnthropicContent(payload) : extractContent(payload)
      if (content === null) throw new LlmError('invalid_response')

      let value: unknown
      try {
        value = JSON.parse(stripFence(content))
      } catch {
        throw new LlmError('invalid_response')
      }
      try {
        return parse(value)
      } catch {
        throw new LlmError('invalid_response')
      }
    },
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** OpenAI 用 prompt_tokens/completion_tokens，Anthropic 用 input_tokens/output_tokens。 */
function extractUsage(payload: unknown, anthropic: boolean): LlmUsage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const usage = (payload as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const record = usage as Record<string, unknown>
  if (anthropic) {
    const inputTokens = count(record.input_tokens)
    const outputTokens = count(record.output_tokens)
    const cachedTokens = count(record.cache_read_input_tokens)
    return {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cachedTokens === undefined ? {} : { cachedTokens }),
    }
  }
  const details = record.prompt_tokens_details
  const cachedTokens = typeof details === 'object' && details !== null
    ? count((details as Record<string, unknown>).cached_tokens)
    : undefined
  const inputTokens = count(record.prompt_tokens)
  const outputTokens = count(record.completion_tokens)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
  }
}

function extractContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return null
  const choice = first as Record<string, unknown>
  if (choice.finish_reason === 'length') throw new LlmError('truncated')
  const message = choice.message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as Record<string, unknown>).content
  return typeof content === 'string' ? content : null
}

function extractAnthropicContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (record.stop_reason === 'max_tokens') throw new LlmError('truncated')
  const blocks = record.content
  if (!Array.isArray(blocks)) return null
  const text = blocks
    .filter((block): block is { type: string; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
  return text.length === 0 ? null : text
}

function stripFence(content: string): string {
  const trimmed = content.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced?.[1] ?? trimmed
}
