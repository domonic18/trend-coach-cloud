import type { LlmConfig } from '../config.js'

export type LlmFailure = 'unavailable' | 'rate_limited' | 'invalid_response' | 'truncated' | 'input_too_large'

export class LlmError extends Error {
  constructor(readonly kind: LlmFailure) {
    super(`llm ${kind}`)
    this.name = 'LlmError'
  }
}

export interface LlmRequest {
  system: string
  user: string
  signal?: AbortSignal
}

export interface LlmClient {
  completeJson<T>(request: LlmRequest, parse: (value: unknown) => T): Promise<T>
}

/** OpenAI 兼容 /chat/completions；只接受 JSON 对象，拒绝截断输出。 */
export function createLlmClient(config: LlmConfig): LlmClient {
  const endpoint = `${config.baseUrl}/chat/completions`

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
          headers: {
            'content-type': 'application/json',
            ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
          },
          body: JSON.stringify({
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
      const content = extractContent(payload)
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

function stripFence(content: string): string {
  const trimmed = content.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced?.[1] ?? trimmed
}
