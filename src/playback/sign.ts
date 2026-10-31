import { createHmac } from 'node:crypto'
import { safeEqual } from '../auth/tokens.js'

export interface PlaybackToken {
  v: 1
  /** 签名覆盖的目录前缀，防止 token 被挪用到其它课程媒体。 */
  p: string
  e: number
  s: string
}

export function signPlaybackToken(secret: string, payload: PlaybackToken): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${signature}`
}

export function verifyPlaybackToken(secret: string, token: string, now = Date.now()): PlaybackToken | undefined {
  const separator = token.indexOf('.')
  if (separator <= 0 || separator === token.length - 1) return undefined
  const body = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  if (!safeEqual(signature, expected)) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = payload as Partial<PlaybackToken>
  if (candidate.v !== 1) return undefined
  if (typeof candidate.p !== 'string' || candidate.p.includes('..') || candidate.p.startsWith('/')) return undefined
  if (typeof candidate.e !== 'number' || !Number.isFinite(candidate.e) || candidate.e <= now) return undefined
  if (typeof candidate.s !== 'string' || candidate.s === '') return undefined
  return candidate as PlaybackToken
}
