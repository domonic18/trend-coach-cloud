import { createHmac } from 'node:crypto'
import { safeEqual } from '../auth/tokens.js'

const FIGURE_PATH = /^fig_[A-Za-z0-9._-]{1,60}\/cand_[A-Za-z0-9._-]{1,59}\.(?:jpg|png)$/

function signature(secret: string, relPath: string, expires: number): string {
  return createHmac('sha256', secret).update(`${relPath}\n${expires}`).digest('base64url')
}

/** 按单文件签发，签名覆盖相对路径，换 figureId/candidateId 即失效。 */
export function signFigureUrl(
  secret: string,
  mediaBaseUrl: string,
  relPath: string,
  ttlSec: number,
  now = Date.now(),
): string {
  if (!FIGURE_PATH.test(relPath)) throw new Error('invalid figure path')
  const expires = Math.floor(now / 1000) + ttlSec
  const path = relPath.split('/').map(encodeURIComponent).join('/')
  return `${mediaBaseUrl.replace(/\/+$/, '')}/figures/${path}?expires=${expires}&sig=${signature(secret, relPath, expires)}`
}

export function isFigurePath(relPath: string): boolean {
  return FIGURE_PATH.test(relPath)
}

export function verifyFigureSignature(
  secret: string,
  relPath: string,
  expiresRaw: unknown,
  sig: unknown,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!FIGURE_PATH.test(relPath)) return false
  if (typeof sig !== 'string' || sig === '') return false
  const expires = Number(expiresRaw)
  if (!Number.isInteger(expires) || expires <= nowSec) return false
  return safeEqual(sig, signature(secret, relPath, expires))
}
