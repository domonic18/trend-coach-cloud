import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Pool } from 'pg'
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_PATTERN,
  type AccountService,
} from '../accounts/service.js'
import type { AppConfig } from '../config.js'
import { badRequest, serviceUnavailable, tooManyRequests } from '../errors.js'
import { clientIp, requirePortalSession } from '../http/principal.js'
import { asObject, optionalStringField, stringField } from '../http/validation.js'
import type { RateLimiter } from '../rate-limit.js'

const DEVICE_ID = /^[A-Za-z0-9._:-]{8,128}$/

export interface PortalRouteDeps {
  accounts: AccountService
  config: AppConfig
  limiter: RateLimiter
  pool: Pool
}

export interface ReleaseManifest {
  dshVersion: string
  webAppPackage: string
  plugin: {
    name: string
    version: string
    fileName: string
    sha256: string | null
    sizeBytes: number | null
    publishedAt: string
    notes: string[]
  } | null
}

function usernameField(body: Record<string, unknown>): string {
  return stringField(body, 'username', { min: 3, max: 32, pattern: USERNAME_PATTERN })
}

function passwordField(body: Record<string, unknown>, key = 'password'): string {
  return stringField(body, key, { min: PASSWORD_MIN, max: PASSWORD_MAX })
}

function publicCache(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'public, max-age=60')
}

/** 发布清单由部署时换入；缺失或格式错误按“暂无版本”返回，门户不因此 500。 */
async function readReleases(): Promise<ReleaseManifest> {
  const file = join(process.cwd(), 'content', 'releases.json')
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return { dshVersion: '0.2.1-rc.5', webAppPackage: '@deepseek-ai/dsh-web-app', plugin: null }
  }
  if (typeof raw !== 'object' || raw === null) {
    throw serviceUnavailable('release manifest invalid')
  }
  const record = raw as Record<string, unknown>
  const pluginRaw = record.plugin
  const plugin = pluginRaw === null || pluginRaw === undefined
    ? null
    : (() => {
      if (typeof pluginRaw !== 'object') throw serviceUnavailable('release manifest invalid')
      const item = pluginRaw as Record<string, unknown>
      const notes = Array.isArray(item.notes)
        ? item.notes.filter((note): note is string => typeof note === 'string').slice(0, 20)
        : []
      if (
        typeof item.name !== 'string'
        || typeof item.version !== 'string'
        || typeof item.fileName !== 'string'
        || typeof item.publishedAt !== 'string'
        || (item.sha256 !== null && item.sha256 !== undefined && typeof item.sha256 !== 'string')
        || (item.sizeBytes !== null && item.sizeBytes !== undefined && typeof item.sizeBytes !== 'number')
      ) {
        throw serviceUnavailable('release manifest invalid')
      }
      return {
        name: item.name,
        version: item.version,
        fileName: item.fileName,
        sha256: typeof item.sha256 === 'string' ? item.sha256 : null,
        sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : null,
        publishedAt: item.publishedAt,
        notes,
      }
    })()
  return {
    dshVersion: typeof record.dshVersion === 'string' ? record.dshVersion : '0.2.1-rc.5',
    webAppPackage: typeof record.webAppPackage === 'string'
      ? record.webAppPackage
      : '@deepseek-ai/dsh-web-app',
    plugin,
  }
}

export function registerPortalRoutes(app: FastifyInstance, deps: PortalRouteDeps): void {
  const { accounts, config, limiter, pool } = deps

  const portalLimit = (request: Parameters<typeof clientIp>[0]): void => {
    if (!limiter.take(`portal:${clientIp(request)}`, config.rateLimitPortalPerMinute)) {
      throw tooManyRequests()
    }
  }

  app.post('/v1/portal/auth/register', async (request, reply) => {
    if (!limiter.take(`register:${clientIp(request)}`, config.rateLimitRegisterPerMinute)) {
      throw tooManyRequests()
    }
    const body = asObject(request.body)
    const displayName = optionalStringField(body, 'displayName', { min: 1, max: 200 })
    const session = await accounts.register({
      username: usernameField(body),
      password: passwordField(body),
      ...(displayName === undefined ? {} : { displayName }),
    })
    return reply.code(201).send(session)
  })

  app.post('/v1/portal/auth/login', async request => {
    portalLimit(request)
    const body = asObject(request.body)
    const username = usernameField(body)
    // 同一用户名在多 IP 下也只给固定次数的尝试，避免撞库。
    if (!limiter.take(`portal-login-user:${username}`, config.rateLimitLoginPerMinute)) {
      throw tooManyRequests()
    }
    const password = stringField(body, 'password', { max: PASSWORD_MAX })
    return accounts.login(username, password, 'portal')
  })

  app.get('/v1/portal/auth/session', async request => {
    const principal = await requirePortalSession(request, accounts)
    return { user: await accounts.getProfile(principal.userId) }
  })

  app.delete('/v1/portal/auth/session', async request => {
    const principal = await requirePortalSession(request, accounts)
    await accounts.revokeSession(principal.tokenHash)
    return { revoked: true }
  })

  app.get('/v1/portal/me', async request => {
    const principal = await requirePortalSession(request, accounts)
    return { profile: await accounts.getProfile(principal.userId) }
  })

  app.patch('/v1/portal/me', async request => {
    const principal = await requirePortalSession(request, accounts)
    const body = asObject(request.body)
    const displayName = stringField(body, 'displayName', { min: 1, max: 200 })
    return { profile: await accounts.updateProfile(principal.userId, displayName) }
  })

  app.post('/v1/portal/me/password', async request => {
    const principal = await requirePortalSession(request, accounts)
    const body = asObject(request.body)
    const currentPassword = stringField(body, 'currentPassword', { max: PASSWORD_MAX })
    const newPassword = passwordField(body, 'newPassword')
    await accounts.changePassword(principal.userId, currentPassword, newPassword)
    return { updated: true }
  })

  app.get('/v1/portal/me/devices', async request => {
    const principal = await requirePortalSession(request, accounts)
    return { devices: await accounts.listDevices(principal.userId) }
  })

  app.delete<{ Params: { deviceId: string } }>('/v1/portal/me/devices/:deviceId', async request => {
    const principal = await requirePortalSession(request, accounts)
    const deviceId = request.params.deviceId
    if (!DEVICE_ID.test(deviceId)) throw badRequest('deviceId invalid')
    await accounts.revokeDevice(principal.userId, deviceId)
    return { revoked: true }
  })

  app.get('/v1/portal/releases', async (_request, reply) => {
    return publicCache(reply).send(await readReleases())
  })

  app.get('/v1/portal/stats', async (request, reply) => {
    portalLimit(request)
    const { rows } = await pool.query<{
      courses: string
      knowledge_points: string
      segments: string
      articles: string
    }>(
      `SELECT
         (SELECT count(*) FROM courses WHERE status = 'published')::text AS courses,
         (SELECT count(*) FROM knowledge_points kp JOIN courses c ON c.course_id = kp.course_id
           WHERE c.status = 'published')::text AS knowledge_points,
         (SELECT count(*) FROM segments s JOIN courses c ON c.course_id = s.course_id
           WHERE c.status = 'published' AND s.status = 'published')::text AS segments,
         (SELECT count(*) FROM articles a JOIN knowledge_points kp ON kp.knowledge_point_id = a.knowledge_point_id
           JOIN courses c ON c.course_id = kp.course_id
           WHERE c.status = 'published' AND a.status = 'published')::text AS articles`,
    )
    const row = rows[0]
    return publicCache(reply).send({
      courses: Number(row?.courses ?? 0),
      knowledgePoints: Number(row?.knowledge_points ?? 0),
      segments: Number(row?.segments ?? 0),
      articles: Number(row?.articles ?? 0),
    })
  })
}
