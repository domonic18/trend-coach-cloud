import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { AppConfig } from '../config.js'
import { HttpError } from '../errors.js'
import { verifyPlaybackToken } from '../playback/sign.js'
import { parseRange } from './range.js'

const MEDIA_FILE = /\.(m3u8|key|ts|m4s|mp4)$/i

const MIME_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.key': 'application/octet-stream',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
}

export interface MediaRouteDeps {
  config: AppConfig
  pool: Pool
}

/** 仅本地开发使用；生产媒体走 CDN，业务进程不代理媒体流。 */
export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  const root = resolve(deps.config.mediaLocalDir ?? '.')
  const { config, pool } = deps

  app.get('/media/*', async (request, reply) => {
    const wildcard = (request.params as Record<string, string>)['*'] ?? ''
    let relative: string
    try {
      relative = decodeURIComponent(wildcard)
    } catch {
      throw new HttpError(400, 'invalid media path')
    }

    const rawToken = (request.query as Record<string, unknown>).token
    const token = typeof rawToken === 'string' ? rawToken : undefined
    if (token === undefined) throw new HttpError(403, 'playback token invalid or expired')
    const payload = verifyPlaybackToken(config.mediaSigningSecret, token)
    if (payload === undefined) throw new HttpError(403, 'playback token invalid or expired')
    if (!relative.startsWith(payload.p)) throw new HttpError(403, 'playback token scope mismatch')

    const session = await pool.query(
      `SELECT 1 FROM playback_sessions
       WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [payload.s],
    )
    if (session.rowCount === 0) throw new HttpError(403, 'playback session closed')

    if (!MEDIA_FILE.test(relative)) throw new HttpError(404, 'not found')
    const filePath = resolve(root, relative)
    if (!filePath.startsWith(root + sep)) throw new HttpError(404, 'not found')
    const info = await stat(filePath).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new HttpError(404, 'not found')

    const extension = relative.slice(relative.lastIndexOf('.')).toLowerCase()
    if (extension === '.m3u8') {
      const playlist = await readFile(filePath, 'utf8')
      return reply
        .type('application/vnd.apple.mpegurl')
        .header('cache-control', 'no-store')
        .send(rewritePlaylist(playlist, token))
    }

    const range = parseRange(request.headers.range, info.size)
    if (range === 'invalid') {
      return reply.code(416).header('content-range', `bytes */${info.size}`).send()
    }
    const start = range?.start ?? 0
    const end = range?.end ?? info.size - 1
    reply.header('accept-ranges', 'bytes').header('cache-control', 'no-store')
    if (range !== undefined) reply.code(206).header('content-range', `bytes ${start}-${end}/${info.size}`)
    return reply
      .type(MIME_TYPES[extension] ?? 'application/octet-stream')
      .header('content-length', String(end - start + 1))
      .send(createReadStream(filePath, { start, end }))
  })
}

function rewritePlaylist(body: string, token: string): string {
  const withQuery = (uri: string): string => uri.includes('token=') ? uri : `${uri}${uri.includes('?') ? '&' : '?'}token=${token}`
  return body
    .replace(/URI="([^"]*)"/g, (match, uri: string) => `URI="${withQuery(uri)}"`)
    .replace(/^(?!#)(\S+\.(?:ts|m4s|mp4|key))$/gm, (_match, uri: string) => withQuery(uri))
}
