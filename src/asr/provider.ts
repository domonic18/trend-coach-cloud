import type { AsrConfig } from '../config.js'

export type AsrFailureKind = 'rate_limited' | 'unavailable' | 'invalid_response'

export class AsrError extends Error {
  constructor(readonly kind: AsrFailureKind) {
    super(`asr ${kind}`)
    this.name = 'AsrError'
  }
}

export interface AsrProvider {
  transcribe(wav: Uint8Array, durationMs: number): Promise<string>
}

/** 允许配置里直接粘贴完整端点；统一归一到 host[/path]，再拼官方路径。 */
export function normalizeAsrBaseUrl(raw: string): string {
  return raw.trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:v1\/)?speech_to_text$/i, '')
    .replace(/\/v1$/i, '')
}

/** OpenAI 兼容转写端点根：粘贴完整 /audio/transcriptions 时也能归一。 */
export function normalizeOpenAiBaseUrl(raw: string): string {
  return raw.trim()
    .replace(/\/+$/, '')
    .replace(/\/audio\/transcriptions$/i, '')
}

export function createAsrProvider(config: AsrConfig): AsrProvider {
  return config.protocol === 'openai'
    ? createOpenAiProvider(config)
    : createMiniMaxProvider(config)
}

export function createMiniMaxProvider(config: AsrConfig): AsrProvider {
  const endpoint = `${normalizeAsrBaseUrl(config.baseUrl)}/v1/speech_to_text`

  return {
    async transcribe(wav, _durationMs) {
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'voice.wav')
      form.append('model', config.model)
      form.append('response_format', 'json')

      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(config.timeoutMs),
        })
      } catch {
        throw new AsrError('unavailable')
      }

      if (response.status === 429) throw new AsrError('rate_limited')
      if (response.status >= 500) throw new AsrError('unavailable')
      if (!response.ok) throw new AsrError('invalid_response')

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new AsrError('invalid_response')
      }
      if (typeof payload !== 'object' || payload === null) throw new AsrError('invalid_response')
      const record = payload as Record<string, unknown>
      const baseResp = record.base_resp
      if (typeof baseResp === 'object' && baseResp !== null
        && (baseResp as Record<string, unknown>).status_code !== 0) {
        throw new AsrError('invalid_response')
      }
      if (typeof record.text !== 'string') throw new AsrError('invalid_response')
      return record.text
    },
  }
}

export function createOpenAiProvider(config: AsrConfig): AsrProvider {
  const endpoint = `${normalizeOpenAiBaseUrl(config.baseUrl)}/audio/transcriptions`

  return {
    async transcribe(wav, _durationMs) {
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'voice.wav')
      form.append('model', config.model)
      form.append('response_format', 'json')

      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(config.timeoutMs),
        })
      } catch {
        throw new AsrError('unavailable')
      }

      if (response.status === 429) throw new AsrError('rate_limited')
      if (response.status >= 500) throw new AsrError('unavailable')
      if (!response.ok) throw new AsrError('invalid_response')

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new AsrError('invalid_response')
      }
      if (typeof payload !== 'object' || payload === null) throw new AsrError('invalid_response')
      const text = (payload as Record<string, unknown>).text
      if (typeof text !== 'string') throw new AsrError('invalid_response')
      return text
    },
  }
}
