import type { FastifyInstance } from 'fastify'
import type { AccountService } from '../accounts/service.js'
import type { AppConfig } from '../config.js'
import { badRequest, tooManyRequests } from '../errors.js'
import { clientIp, requirePrincipal, requireSession } from '../http/principal.js'
import { asObject, stringField } from '../http/validation.js'
import { RateLimiter } from '../rate-limit.js'
import type { AuthService } from './service.js'

const DEVICE_ID = /^[A-Za-z0-9._:-]{8,128}$/
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/
const USERNAME = /^[a-z][a-z0-9._-]{2,31}$/

export interface AuthRouteDeps {
  auth: AuthService
  accounts: AccountService
  config: AppConfig
  limiter: RateLimiter
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { auth, accounts, config, limiter } = deps

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

  app.post('/v1/auth/revoke', async request => {
    const principal = await requirePrincipal(request, auth)
    await auth.revokeDevice(principal.deviceId)
    return { revoked: true }
  })

  app.post('/v1/auth/device/approve', async request => {
    if (!limiter.take(`device-approve:${clientIp(request)}`, config.rateLimitDeviceApprovePerMinute)) {
      throw tooManyRequests()
    }
    const body = asObject(request.body)
    const userCode = stringField(body, 'userCode', { max: 16 }).trim().toUpperCase()
    if (!USER_CODE.test(userCode)) throw badRequest('userCode invalid')
    // 先确认设备码有效，避免错误凭据或无效设备码白耗一次邀请码。
    await auth.assertDeviceCode(userCode)

    let userId: string
    if (typeof request.headers.authorization === 'string') {
      const principal = await requireSession(request, accounts, ['operator', 'admin'])
      userId = body.userId === undefined ? principal.userId : stringField(body, 'userId', { max: 64 })
    } else if (body.inviteCode !== undefined) {
      const inviteCode = stringField(body, 'inviteCode', { max: 32 })
      const password = stringField(body, 'password', { min: 10, max: 128 })
      userId = await accounts.redeemInvite(inviteCode, password)
    } else {
      const username = stringField(body, 'username', { min: 3, max: 32, pattern: USERNAME })
      const password = stringField(body, 'password', { max: 128 })
      userId = await accounts.verifyCredentials(username, password)
    }
    await auth.approveDeviceCode({ userCode, userId })
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>趋势伴学设备授权</title>
<h1>趋势伴学设备授权</h1>
<p>设备码：<code>${escapeHtml(userCode)}</code></p>
<p>使用管理员创建的账号登录；首次登录请填写邀请码并设置密码。</p>
<form id="form">
  <label>用户名 <input id="username" autocomplete="username"></label>
  <p><label>密码 <input id="password" type="password" autocomplete="current-password"></label></p>
  <details>
    <summary>首次登录（使用邀请码）</summary>
    <p><label>邀请码 <input id="invite" autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX"></label></p>
    <p>填写邀请码时，密码栏用于设置新密码（至少 10 个字符）。</p>
  </details>
  <p><button id="approve">批准授权</button></p>
</form>
<p id="msg"></p>
<script>
document.getElementById('approve').addEventListener('click', async event => {
  event.preventDefault()
  const message = document.getElementById('msg')
  const username = document.getElementById('username').value.trim()
  const password = document.getElementById('password').value
  const inviteCode = document.getElementById('invite').value.trim()
  const payload = inviteCode === ''
    ? { userCode: ${JSON.stringify(userCode)}, username, password }
    : { userCode: ${JSON.stringify(userCode)}, inviteCode, password }
  message.textContent = '正在授权…'
  const response = await fetch('/v1/auth/device/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  message.textContent = response.ok
    ? '已授权，请回到客户端等待生效。'
    : response.status === 404
      ? '设备码无效或已过期，请回到客户端重新发起授权。'
      : '授权失败：账号、密码或邀请码不正确，或账号已被禁用。'
})
</script>`
}
