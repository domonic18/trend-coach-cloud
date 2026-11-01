import type { Pool } from 'pg'
import type { AppConfig } from '../config.js'
import type { AuthService, Principal } from '../auth/service.js'
import { randomToken } from '../auth/tokens.js'
import { HttpError, tooManyRequests } from '../errors.js'
import { parseSegmentId } from '../kb/service.js'
import { signPlaybackToken } from './sign.js'

export interface PlaybackSessionOut {
  sessionId: string
  playlistUrl: string
  expiresAt: number
  watermark: { label: string }
}

export class PlaybackService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly auth: AuthService,
  ) {}

  async createSession(principal: Principal, rawSegmentId: string): Promise<PlaybackSessionOut> {
    const segmentId = parseSegmentId(rawSegmentId)
    const segment = await this.pool.query<{ course_id: string }>(
      `SELECT s.course_id
       FROM segments s JOIN courses c ON c.course_id = s.course_id
       WHERE s.segment_id = $1 AND s.status = 'published' AND c.status = 'published'`,
      [segmentId],
    )
    const courseId = segment.rows[0]?.course_id
    if (courseId === undefined) throw new HttpError(404, 'segment not found')

    const asset = await this.pool.query<{ hls_path: string }>(
      `SELECT hls_path FROM media_assets
       WHERE course_id = $1 AND status = 'ready' AND hls_path IS NOT NULL
       ORDER BY created_at DESC, asset_id DESC LIMIT 1`,
      [courseId],
    )
    const hlsPath = asset.rows[0]?.hls_path
    if (hlsPath === undefined) throw new HttpError(503, 'media asset unavailable')

    const active = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM playback_sessions
       WHERE device_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [principal.deviceId],
    )
    if ((active.rows[0]?.count ?? 0) >= this.config.playbackMaxConcurrent) throw tooManyRequests()

    const sessionId = `ps_${randomToken(8)}`
    const expiresAt = Date.now() + this.config.playbackSessionTtlSec * 1000
    await this.pool.query(
      `INSERT INTO playback_sessions (session_id, user_id, device_id, segment_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, principal.userId, principal.deviceId, segmentId, new Date(expiresAt)],
    )

    const slash = hlsPath.lastIndexOf('/')
    const prefix = slash === -1 ? hlsPath : hlsPath.slice(0, slash + 1)
    const token = signPlaybackToken(this.config.mediaSigningSecret, {
      v: 1,
      p: prefix,
      e: expiresAt,
      s: sessionId,
    })
    const label = await this.auth.watermarkLabel(principal.userId)
    return {
      sessionId,
      playlistUrl: `${this.config.mediaBaseUrl}/${hlsPath.replace(/^\/+/, '')}?token=${encodeURIComponent(token)}`,
      expiresAt,
      watermark: { label },
    }
  }
}
