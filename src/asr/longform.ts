import { readFile } from 'node:fs/promises'
import type { AsrConfig } from '../config.js'
import { parseTimedSentences } from '../pipeline/transcript.js'
import type { TranscriptSentence } from '../pipeline/types.js'
import { AsrError, normalizeAsrBaseUrl, normalizeOpenAiBaseUrl } from './provider.js'

export interface LongFormAsrRequest {
  wavPath: string
  durationMs: number
  language: 'zh' | 'en' | 'auto'
  timeoutMs: number
  signal: AbortSignal
}

export interface LongFormAsr {
  transcribe(request: LongFormAsrRequest): Promise<TranscriptSentence[]>
}

export function createLongFormAsr(config: AsrConfig): LongFormAsr {
  return config.protocol === 'openai'
    ? createOpenAiLongFormAsr(config)
    : createMiniMaxLongFormAsr(config)
}

/** MiniMax 长音频：verbose_json + 句级时间戳；单块不超过 480s。 */
export function createMiniMaxLongFormAsr(config: AsrConfig): LongFormAsr {
  const endpoint = `${normalizeAsrBaseUrl(config.baseUrl)}/v1/speech_to_text`

  return {
    async transcribe(request) {
      const wav = await readFile(request.wavPath)
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav')
      form.append('model', config.model)
      form.append('response_format', 'verbose_json')
      form.append('timestamp_level', 'sentence')
      if (request.language !== 'auto') form.append('language', request.language)

      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}` },
          body: form,
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]),
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
      const baseResp = (payload as Record<string, unknown>).base_resp
      if (typeof baseResp === 'object' && baseResp !== null
        && (baseResp as Record<string, unknown>).status_code !== 0) {
        throw new AsrError('invalid_response')
      }

      const sentences = parseTimedSentences(payload, request.durationMs)
      if (sentences.length === 0) throw new AsrError('invalid_response')
      return sentences
    },
  }
}

/** OpenAI 兼容长音频：verbose_json + segment 时间戳（秒），解析器统一换算毫秒。 */
export function createOpenAiLongFormAsr(config: AsrConfig): LongFormAsr {
  const endpoint = `${normalizeOpenAiBaseUrl(config.baseUrl)}/audio/transcriptions`

  return {
    async transcribe(request) {
      const wav = await readFile(request.wavPath)
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav')
      form.append('model', config.model)
      form.append('response_format', 'verbose_json')
      form.append('timestamp_granularities[]', 'segment')
      if (request.language !== 'auto') form.append('language', request.language)

      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}` },
          body: form,
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]),
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
      const sentences = parseTimedSentences(payload, request.durationMs)
      if (sentences.length === 0) throw new AsrError('invalid_response')
      return sentences
    },
  }
}
