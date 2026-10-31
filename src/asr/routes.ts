import type { FastifyInstance } from 'fastify'
import type { AuthService } from '../auth/service.js'
import type { AppConfig } from '../config.js'
import { badGateway, serviceUnavailable, tooManyRequests, unprocessable } from '../errors.js'
import { requirePrincipal } from '../http/principal.js'
import { RateLimiter } from '../rate-limit.js'
import { MAX_TRANSCRIPT_CHARS, parseAsrBody } from './audio.js'
import { AsrError, type AsrProvider } from './provider.js'

export const ASR_BODY_LIMIT = 3 * 1024 * 1024

export interface AsrRouteDeps {
  asr?: AsrProvider
  auth: AuthService
  config: AppConfig
  limiter: RateLimiter
}

export function cleanTranscript(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function registerAsrRoutes(app: FastifyInstance, deps: AsrRouteDeps): void {
  const { asr, auth, config, limiter } = deps

  app.post('/v1/asr/transcribe', { bodyLimit: ASR_BODY_LIMIT }, async request => {
    const principal = await requirePrincipal(request, auth)
    if (asr === undefined) throw serviceUnavailable('asr service not configured')
    if (!limiter.take(`asr:${principal.deviceId}`, config.rateLimitAsrPerMinute)) {
      throw tooManyRequests()
    }

    const { bytes, durationMs } = parseAsrBody(request.body)

    let raw: string
    try {
      raw = await asr.transcribe(bytes, durationMs)
    } catch (error) {
      if (error instanceof AsrError) {
        request.log.warn({ kind: error.kind }, 'asr upstream failed')
        if (error.kind === 'rate_limited') throw tooManyRequests()
        if (error.kind === 'unavailable') throw serviceUnavailable('asr service unavailable')
        throw badGateway('asr protocol error')
      }
      request.log.warn({ errorName: error instanceof Error ? error.name : typeof error }, 'asr upstream failed')
      throw serviceUnavailable('asr service unavailable')
    }

    const text = cleanTranscript(raw)
    if (text.length === 0) throw unprocessable('no speech detected')
    if ([...text].length > MAX_TRANSCRIPT_CHARS) throw badGateway('asr transcript too long')
    return { text, durationMs }
  })
}
