import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { badRequest, tooManyRequests, unauthorized } from '../errors.js'
import { clientIp } from '../http/principal.js'
import { asObject, stringField } from '../http/validation.js'
import { RateLimiter } from '../rate-limit.js'
import type { AuthService } from './service.js'
import { safeEqual } from './tokens.js'

const DEVICE_ID = /^[A-Za-z0-9._:-]{8,128}$/
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/

export interface AuthRouteDeps {
  auth: AuthService
  config: AppConfig
  limiter: RateLimiter
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { auth, config, limiter } = deps

  app.post('/v1/auth/device/code', async (request, reply) => {
    if (!limiter.take(`device-code:${clientIp(request)}`, config.rateLimitDeviceCodePerMinute)) {
      throw tooManyRequests()
    }
    const body = asObject(request.body)
    const clientId = stringField(body, 'clientId', { max: 64 })
    const deviceId = stringField(body, 'deviceId', { min: 8, max: 128, pattern: DEVICE_ID })
    return auth.startDeviceCode(deviceId, clientId)
  })

  app.post('/v1/auth/device/token', async request => {
    const body = asObject(request.body)
    const deviceCode = stringField(body, 'deviceCode', { max: 256 })
    return auth.pollDeviceToken(deviceCode)
  })

  app.post('/v1/auth/refresh', async request => {
    const body = asObject(request.body)
    const refreshToken = stringField(body, 'refreshToken', { max: 256 })
    const deviceId = stringField(body, 'deviceId', { min: 8, max: 128, pattern: DEVICE_ID })
    return auth.refresh(refreshToken, deviceId)
  })

  app.post('/v1/auth/device/approve', async request => {
    const header = request.headers['x-console-token']
    const provided = Array.isArray(header) ? header[0] : header
    if (provided === undefined || !safeEqual(provided, config.consoleToken)) throw unauthorized('console token required')
    const body = asObject(request.body)
    const userCode = stringField(body, 'userCode', { max: 16 }).trim().toUpperCase()
    if (!USER_CODE.test(userCode)) throw badRequest('userCode invalid')
    const userId = body.userId === undefined ? undefined : stringField(body, 'userId', { max: 64 })
    const displayName = body.displayName === undefined
      ? undefined
      : stringField(body, 'displayName', { max: 200 })
    await auth.approveDeviceCode({
      userCode,
      ...(userId === undefined ? {} : { userId }),
      ...(displayName === undefined ? {} : { displayName }),
    })
    return { approved: true }
  })

  app.get('/device', async (request, reply) => {
    const code = typeof request.query === 'object' && request.query !== null
      ? (request.query as Record<string, unknown>).code
      : undefined
    const userCode = typeof code === 'string' ? code.slice(0, 16) : ''
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(devicePage(userCode))
  })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}

function devicePage(userCode: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>趋势伴学设备授权</title>
<h1>趋势伴学设备授权</h1>
<p>设备码：<code>${escapeHtml(userCode)}</code></p>
<p>账号体系上线前，授权仅限运营人员通过控制台令牌完成。</p>
<label>控制台令牌 <input id="token" type="password" autocomplete="off"></label>
<button id="approve">批准授权</button>
<p id="msg"></p>
<script>
document.getElementById('approve').addEventListener('click', async () => {
  const response = await fetch('/v1/auth/device/approve', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-console-token': document.getElementById('token').value,
    },
    body: JSON.stringify({ userCode: ${JSON.stringify(userCode)} }),
  })
  document.getElementById('msg').textContent = response.ok
    ? '已授权，请回到客户端等待生效。'
    : '授权失败：设备码无效、已过期或控制台令牌不正确。'
})
</script>`
}
