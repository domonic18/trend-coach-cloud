import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { runMigrations } from '../src/migrate.js'
import { seedDatabase } from '../src/seed.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://trend_coach:trend_coach@127.0.0.1:5432/trend_coach_test'
const METRICS_TOKEN = 'test-metrics-token-1234'

const pool = createPool(DATABASE_URL)
let app: FastifyInstance

interface SessionBody {
  token: string
  expiresAt: number
  user: { userId: string; username: string; displayName: string | null; role: string }
}

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: 'local',
    DATABASE_URL,
    LOG_LEVEL: 'silent',
    METRICS_TOKEN,
    RATE_LIMIT_PORTAL_PER_MINUTE: '1000',
    RATE_LIMIT_REGISTER_PER_MINUTE: '1000',
    RATE_LIMIT_LOGIN_PER_MINUTE: '1000',
    ...overrides,
  }
}

async function register(username: string, password: string): Promise<SessionBody> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/portal/auth/register',
    payload: { username, password, displayName: username },
  })
  assert.equal(response.statusCode, 201, response.body)
  return response.json() as SessionBody
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

before(async () => {
  await runMigrations(pool, { reset: true })
  await seedDatabase(pool)
  app = await buildApp({ config: loadConfig(env()), pool })
  await app.ready()
})

after(async () => {
  await app.close()
  await pool.end()
})

test('注册：创建 student 并直接返回门户会话', async () => {
  const session = await register('portal-user-01', 'portal-password-1234')
  assert.equal(session.user.role, 'student')
  assert.equal(session.user.username, 'portal-user-01')
  assert.ok(session.token.length > 20)

  const me = await app.inject({
    method: 'GET',
    url: '/v1/portal/me',
    headers: auth(session.token),
  })
  assert.equal(me.statusCode, 200, me.body)
  const profile = me.json().profile as { role: string; deviceCount: number }
  assert.equal(profile.role, 'student')
  assert.equal(profile.deviceCount, 0)
})

test('注册：用户名重复返回 409，弱密码返回 400', async () => {
  await register('portal-user-02', 'portal-password-1234')
  const duplicate = await app.inject({
    method: 'POST',
    url: '/v1/portal/auth/register',
    payload: { username: 'portal-user-02', password: 'portal-password-1234' },
  })
  assert.equal(duplicate.statusCode, 409)

  const weak = await app.inject({
    method: 'POST',
    url: '/v1/portal/auth/register',
    payload: { username: 'portal-user-03', password: 'short' },
  })
  assert.equal(weak.statusCode, 400)
})

test('登录：错误密码 401；学员不能登录后台会话', async () => {
  await register('portal-user-04', 'portal-password-1234')

  const wrong = await app.inject({
    method: 'POST',
    url: '/v1/portal/auth/login',
    payload: { username: 'portal-user-04', password: 'wrong-password-1234' },
  })
  assert.equal(wrong.statusCode, 401)

  const consoleLogin = await app.inject({
    method: 'POST',
    url: '/v1/auth/session',
    payload: { username: 'portal-user-04', password: 'portal-password-1234' },
  })
  assert.equal(consoleLogin.statusCode, 403)
})

test('学员 token 无法访问后台接口', async () => {
  const session = await register('portal-user-05', 'portal-password-1234')
  const response = await app.inject({
    method: 'GET',
    url: '/v1/admin/users',
    headers: auth(session.token),
  })
  assert.equal(response.statusCode, 403)
})

test('资料：修改显示名并回显', async () => {
  const session = await register('portal-user-06', 'portal-password-1234')
  const updated = await app.inject({
    method: 'PATCH',
    url: '/v1/portal/me',
    headers: auth(session.token),
    payload: { displayName: '新昵称' },
  })
  assert.equal(updated.statusCode, 200, updated.body)
  assert.equal(updated.json().profile.displayName, '新昵称')
})

test('改密：旧会话全部失效，新密码可登录', async () => {
  const session = await register('portal-user-07', 'portal-password-1234')
  const second = await app.inject({
    method: 'POST',
    url: '/v1/portal/auth/login',
    payload: { username: 'portal-user-07', password: 'portal-password-1234' },
  })
  assert.equal(second.statusCode, 200)
  const secondToken = (second.json() as SessionBody).token

  const changed = await app.inject({
    method: 'POST',
    url: '/v1/portal/me/password',
    headers: auth(session.token),
    payload: { currentPassword: 'portal-password-1234', newPassword: 'portal-password-5678' },
  })
  assert.equal(changed.statusCode, 200, changed.body)

  for (const token of [session.token, secondToken]) {
    const stale = await app.inject({
      method: 'GET',
      url: '/v1/portal/auth/session',
      headers: auth(token),
    })
    assert.equal(stale.statusCode, 401)
  }

  const relogin = await app.inject({
    method: 'POST',
    url: '/v1/portal/auth/login',
    payload: { username: 'portal-user-07', password: 'portal-password-5678' },
  })
  assert.equal(relogin.statusCode, 200)
})

test('设备：只能查看与解绑自己的设备', async () => {
  const owner = await register('portal-device-owner', 'portal-password-1234')
  const other = await register('portal-device-other', 'portal-password-1234')
  await pool.query(
    `INSERT INTO devices (device_id, user_id) VALUES ($1, $2)`,
    ['device-portal-0001', owner.user.userId],
  )

  const list = await app.inject({
    method: 'GET',
    url: '/v1/portal/me/devices',
    headers: auth(owner.token),
  })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().devices.length, 1)
  assert.equal(list.json().devices[0].deviceId, 'device-portal-0001')

  const forbidden = await app.inject({
    method: 'DELETE',
    url: '/v1/portal/me/devices/device-portal-0001',
    headers: auth(other.token),
  })
  assert.equal(forbidden.statusCode, 403)

  const revoked = await app.inject({
    method: 'DELETE',
    url: '/v1/portal/me/devices/device-portal-0001',
    headers: auth(owner.token),
  })
  assert.equal(revoked.statusCode, 200, revoked.body)
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM devices WHERE device_id = $1',
    ['device-portal-0001'],
  )
  assert.equal(rows[0]?.status, 'revoked')
})

test('登出：会话随即失效', async () => {
  const session = await register('portal-user-08', 'portal-password-1234')
  const logout = await app.inject({
    method: 'DELETE',
    url: '/v1/portal/auth/session',
    headers: auth(session.token),
  })
  assert.equal(logout.statusCode, 200)
  const after = await app.inject({
    method: 'GET',
    url: '/v1/portal/me',
    headers: auth(session.token),
  })
  assert.equal(after.statusCode, 401)
})

test('公开接口：发布清单与站点统计', async () => {
  const releases = await app.inject({ method: 'GET', url: '/v1/portal/releases' })
  assert.equal(releases.statusCode, 200)
  assert.match(releases.headers['cache-control'] ?? '', /max-age=60/)
  assert.equal(releases.json().dshVersion, '0.2.1-rc.5')

  const stats = await app.inject({ method: 'GET', url: '/v1/portal/stats' })
  assert.equal(stats.statusCode, 200)
  const body = stats.json() as Record<string, number>
  for (const key of ['courses', 'knowledgePoints', 'segments', 'articles']) {
    assert.equal(typeof body[key], 'number')
  }
})

test('注册限流：超出配额返回 429', async () => {
  const limited = await buildApp({
    config: loadConfig(env({ RATE_LIMIT_REGISTER_PER_MINUTE: '1' })),
    pool,
  })
  try {
    const first = await limited.inject({
      method: 'POST',
      url: '/v1/portal/auth/register',
      payload: { username: 'portal-limit-01', password: 'portal-password-1234' },
    })
    assert.equal(first.statusCode, 201)
    const second = await limited.inject({
      method: 'POST',
      url: '/v1/portal/auth/register',
      payload: { username: 'portal-limit-02', password: 'portal-password-1234' },
    })
    assert.equal(second.statusCode, 429)
  } finally {
    await limited.close()
  }
})
