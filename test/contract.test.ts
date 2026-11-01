import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { parse as parseYaml } from 'yaml'
import { buildApp } from '../src/app.js'
import { AsrError, type AsrProvider } from '../src/asr/provider.js'
import type { Grant } from '../src/auth/service.js'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { runMigrations } from '../src/migrate.js'
import { signPlaybackToken } from '../src/playback/sign.js'
import { seedDatabase } from '../src/seed.js'
import { wavBase64 } from './asr-fixtures.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://trend_coach:trend_coach@127.0.0.1:5432/trend_coach_test'
const METRICS_TOKEN = 'test-metrics-token-1234'
const MEDIA_SECRET = 'test-media-signing-secret-1234'
const MEDIA_BASE_URL = 'http://127.0.0.1:3939/media'
const SEGMENT_ID = 'seg-tc101-m1-kp1-1'
const ADMIN_USERNAME = 'admin01'
const ADMIN_PASSWORD = 'bootstrap-password-123'
const STUDENT_PASSWORD = 'student-password-1234'

const pool = createPool(DATABASE_URL)
let mediaDir = ''
let figureDir = ''
let app: FastifyInstance
let routes: string[] = []
let mainGrant: Grant
let adminToken = ''

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
    BOOTSTRAP_ADMIN_USERNAME: ADMIN_USERNAME,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    MEDIA_SIGNING_SECRET: MEDIA_SECRET,
    MEDIA_LOCAL_DIR: mediaDir,
    MEDIA_BASE_URL,
    PIPELINE_FIGURE_DIR: figureDir,
    SEARCH_MIN_SIMILARITY: '0.01',
    RATE_LIMIT_SEARCH_PER_MINUTE: '1000',
    RATE_LIMIT_DEVICE_CODE_PER_MINUTE: '1000',
    RATE_LIMIT_EVENTS_PER_MINUTE: '1000',
    RATE_LIMIT_PROGRESS_PER_MINUTE: '1000',
    RATE_LIMIT_LOGIN_PER_MINUTE: '1000',
    RATE_LIMIT_INVITE_PER_MINUTE: '1000',
    RATE_LIMIT_DEVICE_APPROVE_PER_MINUTE: '1000',
    RATE_LIMIT_ASR_PER_MINUTE: '1000',
    RATE_LIMIT_DEVICE_TOKEN_PER_MINUTE: '1000',
    RATE_LIMIT_REFRESH_PER_MINUTE: '1000',
    RATE_LIMIT_CATALOG_PER_MINUTE: '1000',
    RATE_LIMIT_CONTENT_PER_MINUTE: '1000',
    ...overrides,
  }
}

const fakeAsr: AsrProvider = {
  async transcribe(_wav, durationMs) {
    if (durationMs === 1500) return ` ${String.fromCharCode(7)} `
    if (durationMs === 2000) throw new AsrError('rate_limited')
    if (durationMs === 2500) throw new AsrError('unavailable')
    if (durationMs === 3000) throw new AsrError('invalid_response')
    return '趋势反转的初步信号有哪些？'
  },
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${adminToken}` }
}

function usernameFor(deviceId: string): string {
  return `u${deviceId.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`.slice(0, 32)
}

async function adminCreateUser(payload: Record<string, unknown>): Promise<{ statusCode: number; body: any }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/admin/users',
    headers: adminHeaders(),
    payload,
  })
  return { statusCode: response.statusCode, body: response.json() }
}

async function ensureStudent(deviceId: string, displayName: string): Promise<string> {
  const username = usernameFor(deviceId)
  const created = await adminCreateUser({ username, displayName, role: 'student', password: STUDENT_PASSWORD })
  assert.ok(created.statusCode === 201 || created.statusCode === 409, JSON.stringify(created.body))
  return username
}

async function loginSession(username: string, password: string): Promise<{ statusCode: number; body: SessionBody & { error?: string } }> {
  const response = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { username, password } })
  return { statusCode: response.statusCode, body: response.json() as SessionBody & { error?: string } }
}

function authHeaders(grant: Grant): Record<string, string> {
  return { authorization: `Bearer ${grant.accessToken}`, 'x-device-id': grant.deviceId }
}

async function grantFor(deviceId: string, displayName = '测试学员'): Promise<Grant> {
  const username = await ensureStudent(deviceId, displayName)
  const start = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/code',
    payload: { clientId: 'dsh-plugin-trend-coach', deviceId },
  })
  assert.equal(start.statusCode, 200, start.body)
  const { deviceCode, userCode } = start.json() as { deviceCode: string; userCode: string }

  const pending = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode } })
  assert.equal(pending.json().status, 'pending')

  const approve = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/approve',
    payload: { userCode, username, password: STUDENT_PASSWORD },
  })
  assert.equal(approve.statusCode, 200, approve.body)

  const poll = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode } })
  const body = poll.json() as { status: string; grant?: Grant }
  assert.equal(body.status, 'authorized')
  const grant = body.grant
  assert.ok(grant !== undefined)
  return grant
}

async function userIdFor(deviceId: string): Promise<string> {
  const { rows } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM devices WHERE device_id = $1',
    [deviceId],
  )
  const userId = rows[0]?.user_id
  assert.ok(userId !== undefined)
  return userId
}

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), 'trend-coach-media-'))
  figureDir = await mkdtemp(join(tmpdir(), 'trend-coach-figures-'))
  await mkdir(join(mediaDir, 'hls'), { recursive: true })
  await writeFile(join(mediaDir, 'hls', 'index.m3u8'), [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x00000000000000000000000000000001',
    '#EXTINF:10.0,',
    'seg0001.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n'))
  await writeFile(join(mediaDir, 'hls', 'enc.key'), Buffer.alloc(16, 7))
  await writeFile(join(mediaDir, 'hls', 'seg0001.ts'), Buffer.alloc(1024, 9))

  await runMigrations(pool, { reset: true })
  await seedDatabase(pool)

  const config = loadConfig(env())
  app = await buildApp({
    config,
    pool,
    asr: fakeAsr,
    onRoute: (method, url) => routes.push(`${method} ${url}`),
  })
  await app.ready()

  const admin = await loginSession(ADMIN_USERNAME, ADMIN_PASSWORD)
  assert.equal(admin.statusCode, 200, JSON.stringify(admin.body))
  assert.equal(admin.body.user.role, 'admin')
  adminToken = admin.body.token

  mainGrant = await grantFor('device-main-0001')
})

after(async () => {
  await app.close()
  await pool.end()
  await rm(mediaDir, { recursive: true, force: true })
  await rm(figureDir, { recursive: true, force: true })
})

test('GET /health 报告数据库可用', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { ok: true })
})

test('GET /metrics 需要指标令牌', async () => {
  const denied = await app.inject({ method: 'GET', url: '/metrics' })
  assert.equal(denied.statusCode, 401)

  const response = await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  })
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'] ?? '', /text\/plain/)
  assert.match(response.body, /trend_coach_http_requests_total/)
  assert.match(response.body, /trend_coach_http_request_duration_seconds/)
})

test('OpenAPI 与注册路由双向一致', async () => {
  const document = parseYaml(
    await readFile(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8'),
  ) as { paths: Record<string, Record<string, unknown>> }
  const documented = new Set<string>()
  const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) {
      if (METHODS.has(method)) documented.add(`${method.toUpperCase()} ${path}`)
    }
  }
  const registered = new Set(
    routes
      .map(route => route.replace(/:([A-Za-z0-9_]+)/g, '{$1}'))
      // HEAD 由 GET 自动注册；/device、/media/*、/metrics、/admin 与门户静态资源是运维入口，不对外发布契约。
      .filter(route => !route.startsWith('HEAD '))
      .filter(route => route !== 'OPTIONS *')
      .filter(route => !route.endsWith(' /device'))
      .filter(route => !route.includes(' /media/'))
      .filter(route => !route.includes(' /admin'))
      .filter(route => route !== 'GET /metrics')
      .filter(route => !/^GET \/(assets\/|downloads\/)/.test(route))
      .filter(route => !/^GET \/.*\.html$/.test(route))
      .filter(route => !['GET /routes.json', 'GET /sitemap.xml', 'GET /robots.txt', 'GET /favicon.ico'].includes(route)),
  )
  assert.deepEqual([...registered].sort(), [...documented].sort())
})

test('设备码：待批准、错误凭据、批准、重复轮询', async () => {
  const start = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/code',
    payload: { clientId: 'unknown-client', deviceId: 'device-code-0001' },
  })
  assert.equal(start.statusCode, 400)

  const created = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/code',
    payload: { clientId: 'dsh-plugin-trend-coach', deviceId: 'device-code-0001' },
  })
  assert.equal(created.statusCode, 200)
  const { deviceCode, userCode, verificationUri, expiresIn, interval } = created.json() as {
    deviceCode: string
    userCode: string
    verificationUri: string
    expiresIn: number
    interval: number
  }
  assert.match(userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal(verificationUri, `http://127.0.0.1:3939/device?code=${userCode}`)
  assert.equal(expiresIn, 300)
  assert.equal(interval, 2)

  const username = await ensureStudent('device-code-0001', '设备学员')

  const wrongPassword = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/approve',
    payload: { userCode, username, password: 'wrong-password-123' },
  })
  assert.equal(wrongPassword.statusCode, 401)

  const unknownAccount = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/approve',
    payload: { userCode, username: 'nobody-01', password: 'wrong-password-123' },
  })
  assert.equal(unknownAccount.statusCode, 401)

  // 设备码无效时先返回 404，不消耗一次密码校验。
  const badCode = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/approve',
    payload: { userCode: 'ZZZZ-ZZZZ', username, password: STUDENT_PASSWORD },
  })
  assert.equal(badCode.statusCode, 404)

  const pending = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode } })
  assert.deepEqual(pending.json(), { status: 'pending' })

  const approved = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/approve',
    payload: { userCode, username, password: STUDENT_PASSWORD },
  })
  assert.equal(approved.statusCode, 200)
  assert.deepEqual(approved.json(), { approved: true })

  const authorized = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode } })
  const grant = authorized.json() as { status: string; grant: Grant }
  assert.equal(grant.status, 'authorized')
  assert.equal(grant.grant.deviceId, 'device-code-0001')
  assert.ok(grant.grant.expiresAt > Date.now())

  const replay = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode } })
  assert.deepEqual(replay.json(), { status: 'expired' })
})

test('设备码：运营账号会话可直接批准并绑定自身', async () => {
  const username = 'operator-device-01'
  const created = await adminCreateUser({
    username,
    displayName: '运营设备',
    role: 'operator',
    password: 'operator-password-123',
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))

  const session = await loginSession(username, 'operator-password-123')
  assert.equal(session.statusCode, 200, JSON.stringify(session.body))

  const start = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/code',
    payload: { clientId: 'dsh-plugin-trend-coach', deviceId: 'device-session-0001' },
  })
  const { deviceCode, userCode } = start.json() as { deviceCode: string; userCode: string }

  const approve = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/approve',
    headers: { authorization: `Bearer ${session.body.token}` },
    payload: { userCode },
  })
  assert.equal(approve.statusCode, 200, approve.body)

  const poll = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode } })
  const grant = (poll.json() as { status: string; grant: Grant }).grant
  assert.equal(grant.deviceId, 'device-session-0001')

  const { rows } = await pool.query<{ role: string }>(
    'SELECT u.role FROM devices d JOIN users u ON u.user_id = d.user_id WHERE d.device_id = $1',
    [grant.deviceId],
  )
  assert.equal(rows[0]?.role, 'operator')
})

test('账号：管理员登录、会话查询与注销', async () => {
  const wrong = await app.inject({
    method: 'POST',
    url: '/v1/auth/session',
    payload: { username: ADMIN_USERNAME, password: 'wrong-password-123' },
  })
  assert.equal(wrong.statusCode, 401)

  const created = await loginSession(ADMIN_USERNAME, ADMIN_PASSWORD)
  assert.equal(created.statusCode, 200, JSON.stringify(created.body))
  assert.equal(created.body.user.username, ADMIN_USERNAME)
  assert.equal(created.body.user.role, 'admin')
  assert.ok(created.body.expiresAt > Date.now())

  const current = await app.inject({
    method: 'GET',
    url: '/v1/auth/session',
    headers: { authorization: `Bearer ${created.body.token}` },
  })
  assert.equal(current.statusCode, 200)
  assert.equal((current.json() as SessionBody).user.username, ADMIN_USERNAME)

  const deleted = await app.inject({
    method: 'DELETE',
    url: '/v1/auth/session',
    headers: { authorization: `Bearer ${created.body.token}` },
  })
  assert.equal(deleted.statusCode, 200)
  assert.deepEqual(deleted.json(), { revoked: true })

  const after = await app.inject({
    method: 'GET',
    url: '/v1/auth/session',
    headers: { authorization: `Bearer ${created.body.token}` },
  })
  assert.equal(after.statusCode, 401)

  const anonymous = await app.inject({ method: 'GET', url: '/v1/auth/session' })
  assert.equal(anonymous.statusCode, 401)
})

test('账号：学员不可登录后台，运营只读，匿名不可访问', async () => {
  const student = await adminCreateUser({
    username: 'student-role-01',
    displayName: '学员角色',
    role: 'student',
    password: STUDENT_PASSWORD,
  })
  assert.equal(student.statusCode, 201, JSON.stringify(student.body))
  const studentLogin = await loginSession('student-role-01', STUDENT_PASSWORD)
  assert.equal(studentLogin.statusCode, 403)

  const operator = await adminCreateUser({
    username: 'operator-role-01',
    displayName: '运营角色',
    role: 'operator',
    password: 'operator-password-123',
  })
  assert.equal(operator.statusCode, 201, JSON.stringify(operator.body))
  const operatorLogin = await loginSession('operator-role-01', 'operator-password-123')
  assert.equal(operatorLogin.statusCode, 200, JSON.stringify(operatorLogin.body))
  const operatorHeaders = { authorization: `Bearer ${operatorLogin.body.token}` }

  const list = await app.inject({ method: 'GET', url: '/v1/admin/users', headers: operatorHeaders })
  assert.equal(list.statusCode, 200, list.body)
  assert.ok((list.json() as { users: unknown[] }).users.length > 0)

  const createDenied = await app.inject({
    method: 'POST',
    url: '/v1/admin/users',
    headers: operatorHeaders,
    payload: { username: 'new-user-01', displayName: '新用户', role: 'student', password: STUDENT_PASSWORD },
  })
  assert.equal(createDenied.statusCode, 403)

  const targetId = (student.body as { user: { userId: string } }).user.userId
  const resetDenied = await app.inject({
    method: 'POST',
    url: `/v1/admin/users/${targetId}/reset`,
    headers: operatorHeaders,
    payload: { password: 'another-password-123' },
  })
  assert.equal(resetDenied.statusCode, 403)

  const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/users' })
  assert.equal(anonymous.statusCode, 401)
})

test('账号：邀请码设置密码、单次使用与改密吊销会话', async () => {
  const created = await adminCreateUser({
    username: 'invite-user-01',
    displayName: '邀请用户',
    role: 'operator',
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  const { inviteCode } = created.body as { inviteCode: string }
  assert.match(inviteCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)

  const beforeRedeem = await loginSession('invite-user-01', 'whatever-password-12')
  assert.equal(beforeRedeem.statusCode, 401)

  const redeemed = await app.inject({
    method: 'POST',
    url: '/v1/auth/invite/redeem',
    payload: { inviteCode: inviteCode.toLowerCase(), password: 'invited-password-123' },
  })
  assert.equal(redeemed.statusCode, 200, redeemed.body)
  assert.deepEqual(redeemed.json(), { redeemed: true })

  const session = await loginSession('invite-user-01', 'invited-password-123')
  assert.equal(session.statusCode, 200, JSON.stringify(session.body))

  const changed = await app.inject({
    method: 'POST',
    url: '/v1/auth/session/password',
    headers: { authorization: `Bearer ${session.body.token}` },
    payload: { currentPassword: 'invited-password-123', newPassword: 'changed-password-123' },
  })
  assert.equal(changed.statusCode, 200, changed.body)
  assert.deepEqual(changed.json(), { updated: true })

  const oldSession = await app.inject({
    method: 'GET',
    url: '/v1/auth/session',
    headers: { authorization: `Bearer ${session.body.token}` },
  })
  assert.equal(oldSession.statusCode, 401)

  assert.equal((await loginSession('invite-user-01', 'invited-password-123')).statusCode, 401)
  assert.equal((await loginSession('invite-user-01', 'changed-password-123')).statusCode, 200)

  const reuse = await app.inject({
    method: 'POST',
    url: '/v1/auth/invite/redeem',
    payload: { inviteCode, password: 'another-password-123' },
  })
  assert.equal(reuse.statusCode, 401)

  const badCode = await app.inject({
    method: 'POST',
    url: '/v1/auth/invite/redeem',
    payload: { inviteCode: 'not-a-code', password: 'another-password-123' },
  })
  assert.equal(badCode.statusCode, 401)
})

test('账号：重置凭据、禁用、列表筛选与自身保护', async () => {
  const created = await adminCreateUser({
    username: 'reset-user-01',
    displayName: '待重置',
    role: 'operator',
    password: 'initial-password-123',
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  const userId = (created.body as { user: { userId: string } }).user.userId

  const rotated = await app.inject({
    method: 'POST',
    url: `/v1/admin/users/${userId}/reset`,
    headers: adminHeaders(),
    payload: { password: 'rotated-password-123' },
  })
  assert.equal(rotated.statusCode, 200, rotated.body)
  assert.deepEqual(rotated.json(), { updated: true })
  assert.equal((await loginSession('reset-user-01', 'rotated-password-123')).statusCode, 200)
  assert.equal((await loginSession('reset-user-01', 'initial-password-123')).statusCode, 401)

  const invited = await app.inject({
    method: 'POST',
    url: `/v1/admin/users/${userId}/reset`,
    headers: adminHeaders(),
  })
  assert.equal(invited.statusCode, 200, invited.body)
  const { inviteCode } = invited.json() as { inviteCode: string }
  assert.match(inviteCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)

  const redeemed = await app.inject({
    method: 'POST',
    url: '/v1/auth/invite/redeem',
    payload: { inviteCode, password: 'reissued-password-123' },
  })
  assert.equal(redeemed.statusCode, 200, redeemed.body)

  const filtered = await app.inject({
    method: 'GET',
    url: '/v1/admin/users?role=operator&query=reset-user&limit=10',
    headers: adminHeaders(),
  })
  assert.equal(filtered.statusCode, 200, filtered.body)
  const page = filtered.json() as { users: { username: string | null; role: string }[]; limit: number; offset: number }
  assert.equal(page.limit, 10)
  assert.equal(page.offset, 0)
  assert.deepEqual(page.users.map(user => user.username), ['reset-user-01'])

  for (const query of ['role=root', 'limit=0', 'limit=101', 'offset=-1']) {
    const invalid = await app.inject({
      method: 'GET',
      url: `/v1/admin/users?${query}`,
      headers: adminHeaders(),
    })
    assert.equal(invalid.statusCode, 400, query)
  }

  const disabled = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/users/${userId}`,
    headers: adminHeaders(),
    payload: { status: 'disabled' },
  })
  assert.equal(disabled.statusCode, 200, disabled.body)
  assert.equal((await loginSession('reset-user-01', 'reissued-password-123')).statusCode, 401)

  const current = await app.inject({
    method: 'GET',
    url: '/v1/auth/session',
    headers: adminHeaders(),
  })
  const adminId = (current.json() as SessionBody).user.userId
  const selfRole = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/users/${adminId}`,
    headers: adminHeaders(),
    payload: { role: 'student' },
  })
  assert.equal(selfRole.statusCode, 403)
  const selfReset = await app.inject({
    method: 'POST',
    url: `/v1/admin/users/${adminId}/reset`,
    headers: adminHeaders(),
    payload: { password: 'whatever-password-12' },
  })
  assert.equal(selfReset.statusCode, 403)
})

test('内容管理：角色边界、课程结构、文章版本与片段校验', async () => {
  const operator = await adminCreateUser({
    username: 'content-operator-01',
    displayName: '内容运营',
    role: 'operator',
    password: 'operator-password-123',
  })
  assert.equal(operator.statusCode, 201, JSON.stringify(operator.body))
  const login = await loginSession('content-operator-01', 'operator-password-123')
  assert.equal(login.statusCode, 200, JSON.stringify(login.body))
  const operatorHeaders = { authorization: `Bearer ${login.body.token}` }

  const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/content/courses' })
  assert.equal(anonymous.statusCode, 401)
  const deviceToken = await app.inject({
    method: 'GET',
    url: '/v1/admin/content/courses',
    headers: authHeaders(mainGrant),
  })
  assert.equal(deviceToken.statusCode, 401)

  const courseId = 'T-M3-2-01'
  const chapterId = 'C1'
  const pointId = 'T-M3-2-KP1'
  const segmentId = 'seg-tm32-c1-kp1-1'

  const createdCourse = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/courses',
    headers: operatorHeaders,
    payload: { courseId, title: '内容管理测试课程' },
  })
  assert.equal(createdCourse.statusCode, 201, createdCourse.body)
  assert.deepEqual(createdCourse.json(), {
    course: { courseId, title: '内容管理测试课程', status: 'draft' },
  })

  const duplicateCourse = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/courses',
    headers: operatorHeaders,
    payload: { courseId, title: '重复课程' },
  })
  assert.equal(duplicateCourse.statusCode, 409)

  const invalidCourse = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/courses',
    headers: operatorHeaders,
    payload: { courseId: 'bad id', title: '非法 ID' },
  })
  assert.equal(invalidCourse.statusCode, 400)

  const emptyCreated = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/courses',
    headers: operatorHeaders,
    payload: { courseId: 'T-M3-2-EMPTY', title: '空课程' },
  })
  assert.equal(emptyCreated.statusCode, 201, emptyCreated.body)
  const emptyTree = await app.inject({
    method: 'GET',
    url: '/v1/admin/content/courses/T-M3-2-EMPTY',
    headers: operatorHeaders,
  })
  assert.deepEqual(emptyTree.json(), {
    course: { courseId: 'T-M3-2-EMPTY', title: '空课程', status: 'draft' },
    chapters: [],
  })

  const createdChapter = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/courses/${courseId}/chapters`,
    headers: operatorHeaders,
    payload: { chapterId, title: '第一章', position: 1 },
  })
  assert.equal(createdChapter.statusCode, 201, createdChapter.body)
  assert.equal((await app.inject({
    method: 'POST',
    url: `/v1/admin/content/courses/${courseId}/chapters`,
    headers: operatorHeaders,
    payload: { chapterId, title: '重复章节' },
  })).statusCode, 409)

  const missingCourseChapter = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/courses/NOPE-404/chapters',
    headers: operatorHeaders,
    payload: { chapterId: 'C9', title: '不存在' },
  })
  assert.equal(missingCourseChapter.statusCode, 404)

  const createdPoint = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/courses/${courseId}/chapters/${chapterId}/knowledge-points`,
    headers: operatorHeaders,
    payload: { knowledgePointId: pointId, title: '知识点一', position: 1 },
  })
  assert.equal(createdPoint.statusCode, 201, createdPoint.body)
  assert.deepEqual(createdPoint.json(), {
    knowledgePoint: {
      knowledgePointId: pointId,
      title: '知识点一',
      position: 1,
      segmentCount: 0,
    },
  })

  const patchedPoint = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/content/knowledge-points/${pointId}`,
    headers: operatorHeaders,
    payload: { title: '知识点一（改）' },
  })
  assert.equal(patchedPoint.statusCode, 200, patchedPoint.body)
  assert.equal((patchedPoint.json() as { knowledgePoint: { title: string } }).knowledgePoint.title, '知识点一（改）')

  const patchedChapter = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/content/courses/${courseId}/chapters/${chapterId}`,
    headers: operatorHeaders,
    payload: { position: 2 },
  })
  assert.equal(patchedChapter.statusCode, 200, patchedChapter.body)
  assert.equal((patchedChapter.json() as { chapter: { position: number } }).chapter.position, 2)

  const emptyPatch = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/content/courses/${courseId}`,
    headers: operatorHeaders,
    payload: {},
  })
  assert.equal(emptyPatch.statusCode, 400)

  const patchedCourse = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/content/courses/${courseId}`,
    headers: operatorHeaders,
    payload: { status: 'published' },
  })
  assert.equal(patchedCourse.statusCode, 200, patchedCourse.body)
  assert.equal((patchedCourse.json() as { course: { status: string } }).course.status, 'published')

  const articleUrl = `/v1/admin/content/courses/${courseId}/chapters/${chapterId}/article`
  const noArticle = await app.inject({
    method: 'GET',
    url: articleUrl,
    headers: operatorHeaders,
  })
  assert.equal(noArticle.statusCode, 200)
  assert.deepEqual(noArticle.json(), { article: null })

  const firstArticle = await app.inject({
    method: 'PUT',
    url: articleUrl,
    headers: operatorHeaders,
    payload: { markdown: '# 标题\n\n正文', status: 'published' },
  })
  assert.equal(firstArticle.statusCode, 200, firstArticle.body)
  const firstBody = (firstArticle.json() as { article: { version: number; status: string; publishedAt: number | null } }).article
  assert.equal(firstBody.version, 1)
  assert.equal(firstBody.status, 'published')
  assert.ok(typeof firstBody.publishedAt === 'number')

  const secondArticle = await app.inject({
    method: 'PUT',
    url: articleUrl,
    headers: operatorHeaders,
    payload: { markdown: '# 标题\n\n正文（改）', status: 'draft' },
  })
  const secondBody = (secondArticle.json() as { article: { version: number; status: string; publishedAt: number | null } }).article
  assert.equal(secondBody.version, 2)
  assert.equal(secondBody.status, 'draft')
  assert.equal(secondBody.publishedAt, firstBody.publishedAt)

  for (const markdown of [
    '<script>alert(1)</script>',
    '<div onclick="x()">x</div>',
    '[x](javascript:alert(1))',
    '<iframe src="x"></iframe>',
  ]) {
    const unsafe = await app.inject({
      method: 'PUT',
      url: articleUrl,
      headers: operatorHeaders,
      payload: { markdown, status: 'draft' },
    })
    assert.equal(unsafe.statusCode, 400, markdown)
  }

  const tooLongArticle = await app.inject({
    method: 'PUT',
    url: articleUrl,
    headers: operatorHeaders,
    payload: { markdown: 'a'.repeat(20001), status: 'draft' },
  })
  assert.equal(tooLongArticle.statusCode, 400)

  const externalImage = await app.inject({
    method: 'PUT',
    url: articleUrl,
    headers: operatorHeaders,
    payload: { markdown: '![外链](https://example.com/a.png)', status: 'draft' },
  })
  assert.equal(externalImage.statusCode, 400)

  const badRange = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/segments',
    headers: operatorHeaders,
    payload: {
      segmentId,
      courseId,
      chapterId,
      knowledgePointId: pointId,
      title: '片段',
      startSec: 100,
      endSec: 100,
      text: '文本',
    },
  })
  assert.equal(badRange.statusCode, 400)

  const unknownPoint = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/segments',
    headers: operatorHeaders,
    payload: {
      segmentId,
      courseId,
      chapterId,
      knowledgePointId: 'T-M3-2-MISSING',
      title: '片段',
      startSec: 0,
      endSec: 100,
      text: '文本',
    },
  })
  assert.equal(unknownPoint.statusCode, 404)

  const mismatchedPoint = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/segments',
    headers: operatorHeaders,
    payload: {
      segmentId,
      courseId: 'T-M3-2-EMPTY',
      chapterId,
      knowledgePointId: pointId,
      title: '片段',
      startSec: 0,
      endSec: 100,
      text: '文本',
    },
  })
  assert.equal(mismatchedPoint.statusCode, 400)

  const createdSegment = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/segments',
    headers: operatorHeaders,
    payload: {
      segmentId,
      courseId,
      chapterId,
      knowledgePointId: pointId,
      title: '片段一',
      startSec: 0,
      endSec: 100,
      text: '趋势的定义',
      status: 'published',
    },
  })
  assert.equal(createdSegment.statusCode, 201, createdSegment.body)
  const segment = (createdSegment.json() as { segment: { status: string; hasEmbedding: boolean } }).segment
  assert.equal(segment.status, 'published')
  assert.equal(segment.hasEmbedding, false)

  const duplicateSegment = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/segments',
    headers: operatorHeaders,
    payload: {
      segmentId,
      courseId,
      chapterId,
      knowledgePointId: pointId,
      title: '重复片段',
      startSec: 0,
      endSec: 100,
      text: '重复',
    },
  })
  assert.equal(duplicateSegment.statusCode, 409)

  const listed = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/segments?courseId=${courseId}&knowledgePointId=${pointId}&status=published&query=${encodeURIComponent('趋势')}&offset=0&limit=10`,
    headers: operatorHeaders,
  })
  assert.equal(listed.statusCode, 200, listed.body)
  const page = listed.json() as { segments: { segmentId: string }[]; total: number; offset: number; limit: number }
  assert.equal(page.total, 1)
  assert.equal(page.offset, 0)
  assert.equal(page.limit, 10)
  assert.deepEqual(page.segments.map(item => item.segmentId), [segmentId])

  const emptyListing = await app.inject({
    method: 'GET',
    url: '/v1/admin/content/segments?query=not-present-keyword',
    headers: operatorHeaders,
  })
  assert.equal((emptyListing.json() as { total: number }).total, 0)

  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'status=invalid', 'courseId=bad%20id']) {
    const invalid = await app.inject({
      method: 'GET',
      url: `/v1/admin/content/segments?${query}`,
      headers: operatorHeaders,
    })
    assert.equal(invalid.statusCode, 400, query)
  }

  const patchedSegment = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/content/segments/${segmentId}`,
    headers: operatorHeaders,
    payload: { text: '趋势的定义（改）', startSec: 10 },
  })
  assert.equal(patchedSegment.statusCode, 200, patchedSegment.body)
  const patchedBody = (patchedSegment.json() as {
    segment: { startSec: number; endSec: number; text: string; hasEmbedding: boolean }
  }).segment
  assert.equal(patchedBody.startSec, 10)
  assert.equal(patchedBody.endSec, 100)
  assert.equal(patchedBody.text, '趋势的定义（改）')
  assert.equal(patchedBody.hasEmbedding, false)

  const narrowed = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/content/segments/${segmentId}`,
    headers: operatorHeaders,
    payload: { startSec: 120 },
  })
  assert.equal(narrowed.statusCode, 400)

  const emptySegmentPatch = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/content/segments/${segmentId}`,
    headers: operatorHeaders,
    payload: {},
  })
  assert.equal(emptySegmentPatch.statusCode, 400)

  const missingSegment = await app.inject({
    method: 'PATCH',
    url: '/v1/admin/content/segments/seg-tm32-missing',
    headers: operatorHeaders,
    payload: { title: '不存在' },
  })
  assert.equal(missingSegment.statusCode, 404)

  const tree = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/courses/${courseId}`,
    headers: operatorHeaders,
  })
  assert.equal(tree.statusCode, 200, tree.body)
  const treeBody = tree.json() as {
    course: { status: string }
    chapters: {
      article: { version: number; status: string } | null
      figureCount: number
      knowledgePoints: { segmentCount: number }[]
    }[]
  }
  assert.equal(treeBody.course.status, 'published')
  assert.equal(treeBody.chapters[0]?.knowledgePoints[0]?.segmentCount, 1)
  assert.equal(treeBody.chapters[0]?.article?.version, 2)
  assert.equal(treeBody.chapters[0]?.article?.status, 'draft')
  assert.equal(treeBody.chapters[0]?.figureCount, 0)

  const courses = await app.inject({
    method: 'GET',
    url: '/v1/admin/content/courses',
    headers: operatorHeaders,
  })
  const summary = (courses.json() as {
    courses: {
      courseId: string
      title: string
      status: string
      chapterCount: number
      knowledgePointCount: number
      segmentCount: number
      chapterArticleCount: number
      figureCount: number
    }[]
  }).courses.find(item => item.courseId === courseId)
  assert.deepEqual(summary, {
    courseId,
    title: '内容管理测试课程',
    status: 'published',
    chapterCount: 1,
    knowledgePointCount: 1,
    segmentCount: 1,
    chapterArticleCount: 1,
    figureCount: 0,
  })

  const reindex = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/reindex',
    headers: operatorHeaders,
    payload: { courseId },
  })
  assert.equal(reindex.statusCode, 409)

  const archived = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/content/courses/${courseId}`,
    headers: operatorHeaders,
    payload: { status: 'archived' },
  })
  assert.equal(archived.statusCode, 200, archived.body)
  const studentTree = await app.inject({
    method: 'GET',
    url: `/v1/catalog/courses/${courseId}`,
    headers: authHeaders(mainGrant),
  })
  assert.equal(studentTree.statusCode, 404)
})

test('鉴权：缺失、无效令牌与设备不匹配', async () => {
  const missing = await app.inject({ method: 'POST', url: '/v1/kb/search', payload: { query: '均线' } })
  assert.equal(missing.statusCode, 401)

  const invalid = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: { authorization: 'Bearer not-a-token', 'x-device-id': mainGrant.deviceId },
    payload: { query: '均线' },
  })
  assert.equal(invalid.statusCode, 401)

  const mismatch = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: { authorization: `Bearer ${mainGrant.accessToken}`, 'x-device-id': 'device-other-0001' },
    payload: { query: '均线' },
  })
  assert.equal(mismatch.statusCode, 403)
})

test('检索：命中、topK、过滤与入参边界', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: authHeaders(mainGrant),
    payload: { query: '  均线  ', topK: 3 },
  })
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json() as {
    segments: { segmentId: string; score: number; startSec: number; endSec: number; title: string; text: string }[]
    relatedKnowledgePoints: unknown[]
  }
  assert.ok(body.segments.length > 0)
  assert.ok(body.segments.length <= 3)
  for (const segment of body.segments) {
    assert.match(segment.segmentId, /^seg-[A-Za-z0-9._-]+$/)
    assert.ok(segment.score >= 0 && segment.score <= 1)
    assert.ok(segment.startSec < segment.endSec)
    assert.ok(segment.title.length > 0 && segment.text.length > 0)
  }
  assert.deepEqual(body.relatedKnowledgePoints, [])

  const filtered = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: authHeaders(mainGrant),
    payload: { query: '均线', courseId: 'NOPE' },
  })
  assert.equal(filtered.statusCode, 200)
  assert.deepEqual(filtered.json(), { segments: [], relatedKnowledgePoints: [] })

  const invalidBodies: (Record<string, unknown> | unknown[])[] = [
    { query: '   ' },
    { query: '好'.repeat(501) },
    { query: '均线', topK: 0 },
    { query: '均线', topK: 21 },
    { query: '均线', topK: 1.5 },
    { query: '均线', courseId: 'bad course' },
    [],
  ]
  for (const payload of invalidBodies) {
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/kb/search',
      headers: authHeaders(mainGrant),
      payload,
    })
    assert.equal(invalid.statusCode, 400, JSON.stringify(payload))
  }
})

test('检索：空召回时回退到相关知识点', async () => {
  await pool.query("UPDATE segments SET status = 'archived'")
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/kb/search',
      headers: authHeaders(mainGrant),
      payload: { query: '均线' },
    })
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json() as {
      segments: unknown[]
      relatedKnowledgePoints: { knowledgePointId: string; title: string }[]
    }
    assert.deepEqual(body.segments, [])
    assert.ok(body.relatedKnowledgePoints.some(point => point.knowledgePointId === 'KP-2.1'))
    assert.ok(body.relatedKnowledgePoints.length <= 5)
  } finally {
    await pool.query("UPDATE segments SET status = 'published'")
  }
})

test('检索：低置信命中按未覆盖处理', async () => {
  const weak = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: authHeaders(mainGrant),
    payload: { query: '量子纠缠与超导' },
  })
  assert.equal(weak.statusCode, 200, weak.body)
  assert.deepEqual(weak.json(), { segments: [], relatedKnowledgePoints: [] })

  const exact = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: authHeaders(mainGrant),
    payload: { query: '均线的方向与排列' },
  })
  assert.equal(exact.statusCode, 200, exact.body)
  const body = exact.json() as { segments: { segmentId: string }[] }
  assert.deepEqual(body.segments.map(segment => segment.segmentId), ['seg-tc101-m2-kp2-1'])
})

test('片段详情：权威起止秒、非法与下架', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/kb/segments/${SEGMENT_ID}`,
    headers: authHeaders(mainGrant),
  })
  assert.equal(response.statusCode, 200)
  const segment = response.json() as {
    segmentId: string
    startSec: number
    endSec: number
    score: number
    courseId: string
    knowledgePointId: string
  }
  assert.equal(segment.segmentId, SEGMENT_ID)
  assert.equal(segment.startSec, 192)
  assert.equal(segment.endSec, 400)
  assert.equal(segment.score, 1)
  assert.equal(segment.courseId, 'TC-101')
  assert.equal(segment.knowledgePointId, 'KP-1.1')

  const bad = await app.inject({
    method: 'GET',
    url: '/v1/kb/segments/bad',
    headers: authHeaders(mainGrant),
  })
  assert.equal(bad.statusCode, 400)

  const missing = await app.inject({
    method: 'GET',
    url: '/v1/kb/segments/seg-does-not-exist',
    headers: authHeaders(mainGrant),
  })
  assert.equal(missing.statusCode, 404)

  await pool.query("UPDATE segments SET status = 'archived' WHERE segment_id = $1", [SEGMENT_ID])
  try {
    const archived = await app.inject({
      method: 'GET',
      url: `/v1/kb/segments/${SEGMENT_ID}`,
      headers: authHeaders(mainGrant),
    })
    assert.equal(archived.statusCode, 404)
  } finally {
    await pool.query("UPDATE segments SET status = 'published' WHERE segment_id = $1", [SEGMENT_ID])
  }
})

test('播放会话：签名地址、m3u8 改写、Range 与令牌边界', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/playback/sessions',
    headers: authHeaders(mainGrant),
    payload: { segmentId: SEGMENT_ID },
  })
  assert.equal(created.statusCode, 200, created.body)
  const session = created.json() as {
    sessionId: string
    playlistUrl: string
    expiresAt: number
    watermark: { label: string }
  }
  assert.match(session.sessionId, /^ps_[A-Za-z0-9_-]+$/)
  assert.equal(session.watermark.label, '测试学员')
  assert.ok(session.expiresAt > Date.now())

  const playlistUrl = new URL(session.playlistUrl)
  assert.equal(playlistUrl.origin + playlistUrl.pathname, `${MEDIA_BASE_URL}/hls/index.m3u8`)
  const token = playlistUrl.searchParams.get('token')
  assert.ok(token !== null && token.length > 0)
  const path = `${playlistUrl.pathname}${playlistUrl.search}`

  const playlist = await app.inject({ method: 'GET', url: path })
  assert.equal(playlist.statusCode, 200, playlist.body)
  assert.match(playlist.headers['content-type'] as string, /mpegurl/)
  assert.match(playlist.body, /URI="enc\.key\?token=/)
  assert.match(playlist.body, /seg0001\.ts\?token=/)

  const key = await app.inject({ method: 'GET', url: `/media/hls/enc.key?token=${encodeURIComponent(token)}` })
  assert.equal(key.statusCode, 200)

  const ranged = await app.inject({
    method: 'GET',
    url: `/media/hls/seg0001.ts?token=${encodeURIComponent(token)}`,
    headers: { range: 'bytes=0-9' },
  })
  assert.equal(ranged.statusCode, 206)
  assert.equal(ranged.headers['content-range'], 'bytes 0-9/1024')
  assert.equal(ranged.rawPayload.length, 10)

  const unsatisfiable = await app.inject({
    method: 'GET',
    url: `/media/hls/seg0001.ts?token=${encodeURIComponent(token)}`,
    headers: { range: 'bytes=5000-6000' },
  })
  assert.equal(unsatisfiable.statusCode, 416)
  assert.equal(unsatisfiable.headers['content-range'], 'bytes */1024')

  const noToken = await app.inject({ method: 'GET', url: '/media/hls/index.m3u8' })
  assert.equal(noToken.statusCode, 403)

  const badToken = await app.inject({ method: 'GET', url: '/media/hls/index.m3u8?token=nope' })
  assert.equal(badToken.statusCode, 403)

  const foreign = signPlaybackToken(MEDIA_SECRET, {
    v: 1,
    p: 'other-course/',
    e: Date.now() + 60_000,
    s: session.sessionId,
  })
  const scoped = await app.inject({ method: 'GET', url: `/media/hls/index.m3u8?token=${encodeURIComponent(foreign)}` })
  assert.equal(scoped.statusCode, 403)

  const rootless = signPlaybackToken(MEDIA_SECRET, {
    v: 1,
    p: '',
    e: Date.now() + 60_000,
    s: session.sessionId,
  })
  const traversal = await app.inject({
    method: 'GET',
    url: `/media/..%2Fhls%2Findex.m3u8?token=${encodeURIComponent(rootless)}`,
  })
  assert.equal(traversal.statusCode, 404)

  await pool.query("UPDATE playback_sessions SET expires_at = now() - interval '1 second' WHERE session_id = $1", [session.sessionId])
  const closed = await app.inject({ method: 'GET', url: path })
  assert.equal(closed.statusCode, 403)
})

test('播放会话：片段缺失与并发上限', async () => {
  const missing = await app.inject({
    method: 'POST',
    url: '/v1/playback/sessions',
    headers: authHeaders(mainGrant),
    payload: { segmentId: 'seg-does-not-exist' },
  })
  assert.equal(missing.statusCode, 404)

  const limited = await grantFor('playback-limit-0001')
  for (let index = 0; index < 5; index += 1) {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/playback/sessions',
      headers: authHeaders(limited),
      payload: { segmentId: SEGMENT_ID },
    })
    assert.equal(created.statusCode, 200, created.body)
  }
  const blocked = await app.inject({
    method: 'POST',
    url: '/v1/playback/sessions',
    headers: authHeaders(limited),
    payload: { segmentId: SEGMENT_ID },
  })
  assert.equal(blocked.statusCode, 429)
})

test('播放会话：缺失媒体资源返回 503', async () => {
  await pool.query("DELETE FROM media_assets WHERE asset_id = 'asset-tc101-hls'")
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/playback/sessions',
      headers: authHeaders(mainGrant),
      payload: { segmentId: SEGMENT_ID },
    })
    assert.equal(response.statusCode, 503)
  } finally {
    await seedDatabase(pool)
  }
})

test('刷新：设备绑定、轮换与重放吊销', async () => {
  const initial = await grantFor('refresh-device-0001')

  const wrongDevice = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refreshToken: initial.refreshToken, deviceId: 'refresh-device-0002' },
  })
  assert.equal(wrongDevice.statusCode, 403)

  const rotated = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refreshToken: initial.refreshToken, deviceId: initial.deviceId },
  })
  assert.equal(rotated.statusCode, 200, rotated.body)
  const next = rotated.json() as Grant
  assert.notEqual(next.refreshToken, initial.refreshToken)

  const usable = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: authHeaders(next),
    payload: { query: '均线' },
  })
  assert.equal(usable.statusCode, 200)

  const replay = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refreshToken: initial.refreshToken, deviceId: initial.deviceId },
  })
  assert.equal(replay.statusCode, 401)

  const revoked = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: authHeaders(next),
    payload: { query: '均线' },
  })
  assert.equal(revoked.statusCode, 401)
})

test('注销：吊销本设备令牌且不影响其它设备', async () => {
  const target = await grantFor('revoke-device-0001')
  const other = await grantFor('revoke-device-0002')

  const mismatch = await app.inject({
    method: 'POST',
    url: '/v1/auth/revoke',
    headers: { authorization: `Bearer ${other.accessToken}`, 'x-device-id': target.deviceId },
  })
  assert.equal(mismatch.statusCode, 403)

  const revoked = await app.inject({
    method: 'POST',
    url: '/v1/auth/revoke',
    headers: authHeaders(target),
  })
  assert.equal(revoked.statusCode, 200)
  assert.deepEqual(revoked.json(), { revoked: true })

  const afterRevoke = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: authHeaders(target),
    payload: { query: '均线' },
  })
  assert.equal(afterRevoke.statusCode, 401)

  const refreshAfterRevoke = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refreshToken: target.refreshToken, deviceId: target.deviceId },
  })
  assert.equal(refreshAfterRevoke.statusCode, 401)

  const otherStillWorks = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: authHeaders(other),
    payload: { query: '均线' },
  })
  assert.equal(otherStillWorks.statusCode, 200)

  const again = await grantFor('revoke-device-0001')
  const restored = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: authHeaders(again),
    payload: { query: '均线' },
  })
  assert.equal(restored.statusCode, 200)
})

test('事件：同意读写、门禁、白名单与幂等', async () => {
  const grant = await grantFor('events-device-0001')
  const userId = await userIdFor(grant.deviceId)
  const event = {
    eventId: 'evt-contract-0001',
    name: 'search_requested',
    props: { durationMs: 120, topK: 5, hits: 3, empty: false },
  }

  const initial = await app.inject({
    method: 'GET',
    url: '/v1/events/consent',
    headers: authHeaders(grant),
  })
  assert.equal(initial.statusCode, 200)
  assert.deepEqual(initial.json(), { consent: false })

  const denied = await app.inject({
    method: 'POST',
    url: '/v1/events',
    headers: authHeaders(grant),
    payload: event,
  })
  assert.equal(denied.statusCode, 403)

  const invalidConsent = await app.inject({
    method: 'PUT',
    url: '/v1/events/consent',
    headers: authHeaders(grant),
    payload: { consent: 'yes' },
  })
  assert.equal(invalidConsent.statusCode, 400)

  const granted = await app.inject({
    method: 'PUT',
    url: '/v1/events/consent',
    headers: authHeaders(grant),
    payload: { consent: true },
  })
  assert.equal(granted.statusCode, 200)
  assert.deepEqual(granted.json(), { consent: true })

  const { rows: consentRows } = await pool.query<{ events_consent: boolean }>(
    'SELECT events_consent FROM users WHERE user_id = $1',
    [userId],
  )
  assert.equal(consentRows[0]?.events_consent, true)

  const accepted = await app.inject({
    method: 'POST',
    url: '/v1/events',
    headers: authHeaders(grant),
    payload: event,
  })
  assert.equal(accepted.statusCode, 202)
  assert.deepEqual(accepted.json(), { accepted: true })

  const duplicate = await app.inject({
    method: 'POST',
    url: '/v1/events',
    headers: authHeaders(grant),
    payload: event,
  })
  assert.equal(duplicate.statusCode, 202)

  const { rows } = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM events WHERE event_id = $1',
    [event.eventId],
  )
  assert.equal(rows[0]?.count, 1)

  const feedback = await app.inject({
    method: 'POST',
    url: '/v1/events',
    headers: authHeaders(grant),
    payload: { eventId: 'evt-contract-feedback-0001', name: 'feedback_submitted', props: { rating: 'up' } },
  })
  assert.equal(feedback.statusCode, 202)

  const cases: Record<string, unknown>[] = [
    { eventId: 'evt-contract-0002', name: 'answer_generated', props: {} },
    { ...event, eventId: 'evt-contract-0003', props: { ...event.props, query: '均线' } },
    { eventId: 'evt-contract-0004', name: 'citation_clicked', props: { segmentId: 'bad' } },
    { ...event, eventId: 'evt-contract-0005', occurredAt: Date.now() - 31 * 24 * 60 * 60 * 1000 },
    { eventId: 'evt-contract-0006', name: 'feedback_submitted', props: { rating: 'neutral' } },
    { eventId: 'evt-contract-0007', name: 'feedback_submitted', props: { rating: 'up', note: '泄漏' } },
  ]
  for (const payload of cases) {
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: authHeaders(grant),
      payload,
    })
    assert.equal(invalid.statusCode, 400, JSON.stringify(payload))
  }

  const revoked = await app.inject({
    method: 'PUT',
    url: '/v1/events/consent',
    headers: authHeaders(grant),
    payload: { consent: false },
  })
  assert.equal(revoked.statusCode, 200)
  assert.deepEqual(revoked.json(), { consent: false })

  const deniedAfterRevoke = await app.inject({
    method: 'POST',
    url: '/v1/events',
    headers: authHeaders(grant),
    payload: { ...event, eventId: 'evt-contract-0006' },
  })
  assert.equal(deniedAfterRevoke.statusCode, 403)
})

test('体系：课程列表与课程树', async () => {
  const list = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses',
    headers: authHeaders(mainGrant),
  })
  assert.equal(list.statusCode, 200, list.body)
  const { courses } = list.json() as {
    courses: { courseId: string; title: string; chapterCount: number; knowledgePointCount: number; completedCount: number }[]
  }
  assert.equal(courses.length, 1)
  assert.deepEqual(courses[0], {
    courseId: 'TC-101',
    title: '趋势交易基础',
    chapterCount: 3,
    knowledgePointCount: 6,
    completedCount: 0,
  })

  const detail = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses/TC-101',
    headers: authHeaders(mainGrant),
  })
  assert.equal(detail.statusCode, 200, detail.body)
  const course = detail.json() as {
    contractVersion: number
    courseId: string
    chapters: {
      chapterId: string
      hasArticle: boolean
      figureCount: number
      knowledgePoints: Record<string, unknown>[]
    }[]
  }
  assert.equal(course.contractVersion, 2)
  assert.equal(course.courseId, 'TC-101')
  assert.deepEqual(course.chapters.map(chapter => chapter.chapterId), ['M1', 'M2', 'M3'])
  for (const chapter of course.chapters) {
    assert.equal(chapter.hasArticle, true)
    assert.equal(chapter.figureCount, 0)
  }
  const points = course.chapters.flatMap(chapter => chapter.knowledgePoints)
  assert.equal(points.length, 6)
  for (const point of points) {
    assert.equal('startSec' in point, false)
    assert.equal('endSec' in point, false)
    assert.match(point.knowledgePointId as string, /^[A-Za-z0-9._-]+$/)
    assert.match(point.segmentId as string, /^seg-[A-Za-z0-9._-]+$/)
    assert.equal(point.watchedSec, 0)
    assert.equal(point.completed, false)
  }

  const invalid = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses/bad%20id',
    headers: authHeaders(mainGrant),
  })
  assert.equal(invalid.statusCode, 400)

  const missing = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses/NOPE',
    headers: authHeaders(mainGrant),
  })
  assert.equal(missing.statusCode, 404)
})

test('体系：知识点详情只返回定位与相邻知识点', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/catalog/knowledge-points/KP-1.1',
    headers: authHeaders(mainGrant),
  })
  assert.equal(response.statusCode, 200, response.body)
  const detail = response.json() as {
    knowledgePointId: string
    courseId: string
    chapterId: string
    title: string
    segmentId?: string
    adjacentKnowledgePoints: { knowledgePointId: string; title: string }[]
  }
  assert.equal(detail.knowledgePointId, 'KP-1.1')
  assert.equal(detail.courseId, 'TC-101')
  assert.equal(detail.chapterId, 'M1')
  assert.equal(detail.segmentId, SEGMENT_ID)
  assert.equal('article' in detail, false)
  assert.ok(detail.adjacentKnowledgePoints.length <= 5)
  assert.ok(detail.adjacentKnowledgePoints.some(point => point.knowledgePointId === 'KP-1.2'))
  for (const point of detail.adjacentKnowledgePoints) {
    assert.deepEqual(Object.keys(point).sort(), ['knowledgePointId', 'title'])
  }

  const invalid = await app.inject({
    method: 'GET',
    url: '/v1/catalog/knowledge-points/bad%20id',
    headers: authHeaders(mainGrant),
  })
  assert.equal(invalid.statusCode, 400)

  const missing = await app.inject({
    method: 'GET',
    url: '/v1/catalog/knowledge-points/KP-9.9',
    headers: authHeaders(mainGrant),
  })
  assert.equal(missing.statusCode, 404)
})

test('体系：章节教材、图示签名与相邻章节', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses/TC-101/chapters/M1',
    headers: authHeaders(mainGrant),
  })
  assert.equal(response.statusCode, 200, response.body)
  const chapter = response.json() as {
    chapterId: string
    courseId: string
    title: string
    article: { markdown: string; version: number; publishedAt: number } | null
    figures: Record<string, unknown>
    adjacentChapters: { chapterId: string; title: string }[]
  }
  assert.deepEqual(Object.keys(chapter).sort(), [
    'adjacentChapters', 'article', 'chapterId', 'courseId', 'figures', 'title',
  ])
  assert.equal(chapter.chapterId, 'M1')
  assert.equal(chapter.courseId, 'TC-101')
  assert.equal(chapter.title, '第一章 趋势认知')
  assert.ok(chapter.article !== null)
  assert.match(chapter.article.markdown, /趋势/)
  assert.equal(chapter.article.version, 1)
  assert.ok(chapter.article.publishedAt > 0)
  assert.deepEqual(chapter.figures, {})
  assert.ok(chapter.adjacentChapters.length <= 5)
  assert.ok(chapter.adjacentChapters.some(entry => entry.chapterId === 'M2'))
  for (const entry of chapter.adjacentChapters) {
    assert.deepEqual(Object.keys(entry).sort(), ['chapterId', 'title'])
  }

  const invalid = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses/TC-101/chapters/bad%20id',
    headers: authHeaders(mainGrant),
  })
  assert.equal(invalid.statusCode, 400)

  const missing = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses/TC-101/chapters/M9',
    headers: authHeaders(mainGrant),
  })
  assert.equal(missing.statusCode, 404)

  const missingCourse = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses/NOPE/chapters/M1',
    headers: authHeaders(mainGrant),
  })
  assert.equal(missingCourse.statusCode, 404)

  await pool.query(
    "UPDATE chapter_articles SET status = 'draft' WHERE course_id = 'TC-101' AND chapter_id = 'M1'",
  )
  try {
    const draft = await app.inject({
      method: 'GET',
      url: '/v1/catalog/courses/TC-101/chapters/M1',
      headers: authHeaders(mainGrant),
    })
    assert.equal(draft.statusCode, 200)
    assert.equal((draft.json() as { article: unknown }).article, null)
  } finally {
    await pool.query(
      "UPDATE chapter_articles SET status = 'published' WHERE course_id = 'TC-101' AND chapter_id = 'M1'",
    )
  }
})

test('体系：章节图示只下发已选且已发布的签名地址', async () => {
  const figureId = 'fig_test0001'
  const candidateId = 'cand_test0001'
  await mkdir(join(figureDir, figureId), { recursive: true })
  await writeFile(join(figureDir, figureId, `${candidateId}.jpg`), Buffer.alloc(2048, 3))
  await pool.query(
    `INSERT INTO figures (figure_id, course_id, chapter_id, kind, caption, status)
     VALUES ($1, 'TC-101', 'M1', 'keyframe', '均线交叉示意', 'planned')`,
    [figureId],
  )
  await pool.query(
    `INSERT INTO figure_candidates
       (candidate_id, figure_id, rel_path, width, height, bytes, status)
     VALUES ($1, $2, $3, 1600, 900, 2048, 'ready')`,
    [candidateId, figureId, `${figureId}/${candidateId}.jpg`],
  )
  await pool.query(
    `UPDATE figures SET selected_candidate_id = $1, status = 'published', published_at = now()
     WHERE figure_id = $2`,
    [candidateId, figureId],
  )
  const original = await pool.query<{ markdown: string }>(
    "SELECT markdown FROM chapter_articles WHERE course_id = 'TC-101' AND chapter_id = 'M1'",
  )
  const markdown = original.rows[0]?.markdown
  assert.ok(markdown !== undefined)
  await pool.query(
    "UPDATE chapter_articles SET markdown = $1 WHERE course_id = 'TC-101' AND chapter_id = 'M1'",
    [`${markdown}\n\n![均线交叉示意](figure:${figureId})\n`],
  )
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/catalog/courses/TC-101/chapters/M1',
      headers: authHeaders(mainGrant),
    })
    assert.equal(response.statusCode, 200, response.body)
    const chapter = response.json() as {
      figures: Record<string, { url: string; width: number; height: number; alt: string; caption?: string }>
    }
    const figure = chapter.figures[figureId]
    assert.ok(figure !== undefined)
    assert.equal(figure.width, 1600)
    assert.equal(figure.height, 900)
    assert.equal(figure.alt, '均线交叉示意')
    assert.equal(figure.caption, '均线交叉示意')
    const url = new URL(figure.url)
    assert.equal(url.origin, 'http://127.0.0.1:3939')
    assert.equal(url.pathname, `/media/figures/${figureId}/${candidateId}.jpg`)
    assert.ok(Number(url.searchParams.get('expires')) > Math.floor(Date.now() / 1000))
    assert.ok((url.searchParams.get('sig') ?? '') !== '')

    const image = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` })
    assert.equal(image.statusCode, 200)
    assert.equal(image.headers['content-type'], 'image/jpeg')
    assert.equal(image.headers['cache-control'], 'private, max-age=600')
    assert.equal(image.rawPayload.length, 2048)

    const tampered = new URL(figure.url)
    tampered.searchParams.set('sig', 'bad-signature')
    const denied = await app.inject({ method: 'GET', url: `${tampered.pathname}${tampered.search}` })
    assert.equal(denied.statusCode, 403)

    const switched = new URL(figure.url)
    switched.pathname = `/media/figures/fig_other/${candidateId}.jpg`
    const switchedResponse = await app.inject({
      method: 'GET',
      url: `${switched.pathname}${switched.search}`,
    })
    assert.equal(switchedResponse.statusCode, 403)

    await pool.query(
      "UPDATE chapter_articles SET markdown = $1 WHERE course_id = 'TC-101' AND chapter_id = 'M1'",
      [`${markdown}\n\n![缺失](figure:fig_missing)\n`],
    )
    const broken = await app.inject({
      method: 'GET',
      url: '/v1/catalog/courses/TC-101/chapters/M1',
      headers: authHeaders(mainGrant),
    })
    assert.equal(broken.statusCode, 500)
  } finally {
    await pool.query(
      "UPDATE chapter_articles SET markdown = $1 WHERE course_id = 'TC-101' AND chapter_id = 'M1'",
      [markdown],
    )
    await pool.query('DELETE FROM figures WHERE figure_id = $1', [figureId])
    await rm(join(figureDir, figureId), { recursive: true, force: true })
  }
})

test('体系：未发布课程不可见', async () => {
  await pool.query("UPDATE courses SET status = 'draft' WHERE course_id = 'TC-101'")
  try {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/catalog/courses',
      headers: authHeaders(mainGrant),
    })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(list.json(), { courses: [] })

    const course = await app.inject({
      method: 'GET',
      url: '/v1/catalog/courses/TC-101',
      headers: authHeaders(mainGrant),
    })
    assert.equal(course.statusCode, 404)

    const point = await app.inject({
      method: 'GET',
      url: '/v1/catalog/knowledge-points/KP-1.1',
      headers: authHeaders(mainGrant),
    })
    assert.equal(point.statusCode, 404)
  } finally {
    await pool.query("UPDATE courses SET status = 'published' WHERE course_id = 'TC-101'")
  }
})

test('进度：合并、不可回退、幂等与用户隔离', async () => {
  const consent = await app.inject({
    method: 'GET',
    url: '/v1/events/consent',
    headers: authHeaders(mainGrant),
  })
  assert.equal(consent.statusCode, 200)

  const first = await app.inject({
    method: 'PUT',
    url: '/v1/progress/knowledge-points/KP-1.1',
    headers: authHeaders(mainGrant),
    payload: { watchedSec: 120, completed: false },
  })
  assert.equal(first.statusCode, 200, first.body)
  assert.deepEqual(
    (({ knowledgePointId, watchedSec, completed }) => ({ knowledgePointId, watchedSec, completed }))(first.json()),
    { knowledgePointId: 'KP-1.1', watchedSec: 120, completed: false },
  )

  const completed = await app.inject({
    method: 'PUT',
    url: '/v1/progress/knowledge-points/KP-1.1',
    headers: authHeaders(mainGrant),
    payload: { watchedSec: 60, completed: true },
  })
  assert.equal(completed.statusCode, 200)
  const completedBody = completed.json() as { watchedSec: number; completed: boolean }
  assert.equal(completedBody.watchedSec, 120)
  assert.equal(completedBody.completed, true)

  const regressed = await app.inject({
    method: 'PUT',
    url: '/v1/progress/knowledge-points/KP-1.1',
    headers: authHeaders(mainGrant),
    payload: { watchedSec: 30, completed: false },
  })
  assert.equal(regressed.statusCode, 200)
  const regressedBody = regressed.json() as { watchedSec: number; completed: boolean }
  assert.equal(regressedBody.watchedSec, 120)
  assert.equal(regressedBody.completed, true)

  const tree = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses/TC-101',
    headers: authHeaders(mainGrant),
  })
  const point = (tree.json() as {
    chapters: { knowledgePoints: { knowledgePointId: string; watchedSec: number; completed: boolean }[] }[]
  }).chapters.flatMap(chapter => chapter.knowledgePoints)
    .find(entry => entry.knowledgePointId === 'KP-1.1')
  assert.deepEqual(point, {
    knowledgePointId: 'KP-1.1',
    title: '趋势的定义与三种方向',
    position: 1,
    segmentId: SEGMENT_ID,
    watchedSec: 120,
    completed: true,
  })

  const list = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses',
    headers: authHeaders(mainGrant),
  })
  assert.equal((list.json() as { courses: { completedCount: number }[] }).courses[0]?.completedCount, 1)

  const other = await grantFor('progress-other-0001')
  const otherWrite = await app.inject({
    method: 'PUT',
    url: '/v1/progress/knowledge-points/KP-1.1',
    headers: authHeaders(other),
    payload: { watchedSec: 20, completed: false },
  })
  assert.equal(otherWrite.statusCode, 200)
  const otherBody = otherWrite.json() as { watchedSec: number; completed: boolean }
  assert.equal(otherBody.watchedSec, 20)
  assert.equal(otherBody.completed, false)

  const unchanged = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses/TC-101',
    headers: authHeaders(mainGrant),
  })
  const unchangedPoint = (unchanged.json() as {
    chapters: { knowledgePoints: { knowledgePointId: string; watchedSec: number; completed: boolean }[] }[]
  }).chapters.flatMap(chapter => chapter.knowledgePoints)
    .find(entry => entry.knowledgePointId === 'KP-1.1')
  assert.equal(unchangedPoint?.watchedSec, 120)
  assert.equal(unchangedPoint?.completed, true)

  const invalidBodies: unknown[] = [
    { watchedSec: 10 },
    { watchedSec: -1, completed: false },
    { watchedSec: 86401, completed: false },
    { watchedSec: 1.5, completed: false },
    { watchedSec: 10, completed: 'yes' },
    [],
  ]
  for (const payload of invalidBodies) {
    const invalid = await app.inject({
      method: 'PUT',
      url: '/v1/progress/knowledge-points/KP-1.1',
      headers: authHeaders(mainGrant),
      payload: payload as Record<string, unknown>,
    })
    assert.equal(invalid.statusCode, 400, JSON.stringify(payload))
  }

  const missing = await app.inject({
    method: 'PUT',
    url: '/v1/progress/knowledge-points/KP-9.9',
    headers: authHeaders(mainGrant),
    payload: { watchedSec: 10, completed: false },
  })
  assert.equal(missing.statusCode, 404)
})

test('进度限流：单设备超出配额返回 429', async () => {
  const limited = await buildApp({
    config: loadConfig(env({ RATE_LIMIT_PROGRESS_PER_MINUTE: '1' })),
    pool,
  })
  try {
    const first = await limited.inject({
      method: 'PUT',
      url: '/v1/progress/knowledge-points/KP-1.1',
      headers: authHeaders(mainGrant),
      payload: { watchedSec: 10, completed: false },
    })
    assert.equal(first.statusCode, 200)
    const second = await limited.inject({
      method: 'PUT',
      url: '/v1/progress/knowledge-points/KP-1.1',
      headers: authHeaders(mainGrant),
      payload: { watchedSec: 20, completed: false },
    })
    assert.equal(second.statusCode, 429)
  } finally {
    await limited.close()
  }
})

test('检索限流：单设备超出配额返回 429', async () => {
  const limited = await buildApp({
    config: loadConfig(env({ RATE_LIMIT_SEARCH_PER_MINUTE: '1' })),
    pool,
  })
  try {
    const first = await limited.inject({
      method: 'POST',
      url: '/v1/kb/search',
      headers: authHeaders(mainGrant),
      payload: { query: '均线' },
    })
    assert.equal(first.statusCode, 200)
    const second = await limited.inject({
      method: 'POST',
      url: '/v1/kb/search',
      headers: authHeaders(mainGrant),
      payload: { query: '均线' },
    })
    assert.equal(second.statusCode, 429)
  } finally {
    await limited.close()
  }
})

test('设备轮询与刷新限流：超出配额返回 429', async () => {
  const limited = await buildApp({
    config: loadConfig(env({
      RATE_LIMIT_DEVICE_TOKEN_PER_MINUTE: '1',
      RATE_LIMIT_REFRESH_PER_MINUTE: '1',
    })),
    pool,
  })
  try {
    const poll = () => limited.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: 'invalid-device-code' },
    })
    const firstPoll = await poll()
    assert.notEqual(firstPoll.statusCode, 429)
    const secondPoll = await poll()
    assert.equal(secondPoll.statusCode, 429)
    assert.equal(secondPoll.headers['retry-after'], '60')

    const refresh = () => limited.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'invalid-refresh-token', deviceId: 'refresh-limit-0001' },
    })
    const firstRefresh = await refresh()
    assert.notEqual(firstRefresh.statusCode, 429)
    const secondRefresh = await refresh()
    assert.equal(secondRefresh.statusCode, 429)
  } finally {
    await limited.close()
  }
})

test('体系与后台内容读取限流：超出配额返回 429', async () => {
  const limited = await buildApp({
    config: loadConfig(env({
      RATE_LIMIT_CATALOG_PER_MINUTE: '1',
      RATE_LIMIT_CONTENT_PER_MINUTE: '1',
    })),
    pool,
  })
  try {
    const catalog = () => limited.inject({
      method: 'GET',
      url: '/v1/catalog/courses',
      headers: authHeaders(mainGrant),
    })
    assert.equal((await catalog()).statusCode, 200)
    assert.equal((await catalog()).statusCode, 429)

    const content = () => limited.inject({
      method: 'GET',
      url: '/v1/admin/content/courses',
      headers: adminHeaders(),
    })
    assert.equal((await content()).statusCode, 200)
    assert.equal((await content()).statusCode, 429)
  } finally {
    await limited.close()
  }
})

test('语音转写：鉴权、音频校验、空结果与上游错误映射', async () => {
  const payload = (durationMs = 1000) => ({
    audio: wavBase64({ durationMs }),
    format: 'wav',
    durationMs,
  })

  const denied = await app.inject({
    method: 'POST',
    url: '/v1/asr/transcribe',
    payload: payload(),
  })
  assert.equal(denied.statusCode, 401)

  const mismatch = await app.inject({
    method: 'POST',
    url: '/v1/asr/transcribe',
    headers: { authorization: `Bearer ${mainGrant.accessToken}`, 'x-device-id': 'device-other-0001' },
    payload: payload(),
  })
  assert.equal(mismatch.statusCode, 403)

  const invalidBodies: unknown[] = [
    {},
    { audio: wavBase64(), format: 'webm', durationMs: 1000 },
    { audio: '', format: 'wav', durationMs: 1000 },
    { audio: 'not base64!!', format: 'wav', durationMs: 1000 },
    { audio: wavBase64({ sampleRate: 44_100 }), format: 'wav', durationMs: 1000 },
    { audio: wavBase64({ durationMs: 10_000 }), format: 'wav', durationMs: 13_000 },
    { audio: wavBase64(), format: 'wav', durationMs: 0 },
    { audio: wavBase64(), format: 'wav', durationMs: 1.5 },
  ]
  for (const body of invalidBodies) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/asr/transcribe',
      headers: authHeaders(mainGrant),
      payload: body as Record<string, unknown>,
    })
    assert.equal(response.statusCode, 400, JSON.stringify(body))
  }

  const oversized = await app.inject({
    method: 'POST',
    url: '/v1/asr/transcribe',
    headers: authHeaders(mainGrant),
    payload: { audio: 'A'.repeat(3 * 1024 * 1024), format: 'wav', durationMs: 1000 },
  })
  assert.equal(oversized.statusCode, 413)

  const empty = await app.inject({
    method: 'POST',
    url: '/v1/asr/transcribe',
    headers: authHeaders(mainGrant),
    payload: payload(1500),
  })
  assert.equal(empty.statusCode, 422)

  const upstreamFailures: [number, number][] = [[2000, 429], [2500, 503], [3000, 502]]
  for (const [durationMs, statusCode] of upstreamFailures) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/asr/transcribe',
      headers: authHeaders(mainGrant),
      payload: payload(durationMs),
    })
    assert.equal(response.statusCode, statusCode, String(durationMs))
  }

  const ok = await app.inject({
    method: 'POST',
    url: '/v1/asr/transcribe',
    headers: authHeaders(mainGrant),
    payload: payload(12_000),
  })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(ok.json(), { text: '趋势反转的初步信号有哪些？', durationMs: 12_000 })
})

test('语音转写限流：单设备超出配额返回 429', async () => {
  const limited = await buildApp({
    config: loadConfig(env({ RATE_LIMIT_ASR_PER_MINUTE: '1' })),
    pool,
    asr: fakeAsr,
  })
  try {
    const first = await limited.inject({
      method: 'POST',
      url: '/v1/asr/transcribe',
      headers: authHeaders(mainGrant),
      payload: { audio: wavBase64(), format: 'wav', durationMs: 1000 },
    })
    assert.equal(first.statusCode, 200)
    const second = await limited.inject({
      method: 'POST',
      url: '/v1/asr/transcribe',
      headers: authHeaders(mainGrant),
      payload: { audio: wavBase64(), format: 'wav', durationMs: 1000 },
    })
    assert.equal(second.statusCode, 429)
  } finally {
    await limited.close()
  }
})

test('模型配置：仅管理员可读，密钥加密落库且只回显掩码', async () => {
  const operator = await adminCreateUser({
    username: 'model-operator-01',
    displayName: '模型运营',
    role: 'operator',
    password: 'operator-password-123',
  })
  assert.equal(operator.statusCode, 201, JSON.stringify(operator.body))
  const operatorLogin = await loginSession('model-operator-01', 'operator-password-123')
  assert.equal(operatorLogin.statusCode, 200, JSON.stringify(operatorLogin.body))
  const operatorHeaders = { authorization: `Bearer ${operatorLogin.body.token}` }

  const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/model-configs/llm' })
  assert.equal(anonymous.statusCode, 401)
  const deviceToken = await app.inject({
    method: 'GET',
    url: '/v1/admin/model-configs/llm',
    headers: authHeaders(mainGrant),
  })
  assert.equal(deviceToken.statusCode, 401)
  const denied = await app.inject({
    method: 'GET',
    url: '/v1/admin/model-configs/llm',
    headers: operatorHeaders,
  })
  assert.equal(denied.statusCode, 403)

  const empty = await app.inject({ method: 'GET', url: '/v1/admin/model-configs/llm', headers: adminHeaders() })
  assert.equal(empty.statusCode, 200)
  assert.deepEqual(empty.json(), [])

  const apiKey = 'sk-contract-key-123456'
  const created = await app.inject({
    method: 'POST',
    url: '/v1/admin/model-configs/llm',
    headers: adminHeaders(),
    payload: {
      name: 'primary',
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-test',
      purpose: 'content',
      apiKey,
      isDefault: true,
    },
  })
  assert.equal(created.statusCode, 201, created.body)
  const first = created.json() as {
    configId: string
    baseUrl: string
    apiKeyConfigured: boolean
    apiKeyMasked: string | null
    isDefault: boolean
    protocol: string
  }
  assert.match(first.configId, /^llmc_[0-9a-f]{16}$/)
  assert.equal(first.baseUrl, 'https://api.example.com')
  assert.equal(first.protocol, 'openai')
  assert.equal(first.apiKeyConfigured, true)
  assert.equal(first.apiKeyMasked, 'sk-c********3456')
  assert.equal(created.body.includes(apiKey), false)

  const { rows } = await pool.query<{ api_key_encrypted: string }>(
    'SELECT api_key_encrypted FROM llm_configs WHERE config_id = $1',
    [first.configId],
  )
  const stored = rows[0]?.api_key_encrypted ?? ''
  assert.match(stored, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)
  assert.equal(stored.includes(apiKey), false)

  const second = await app.inject({
    method: 'POST',
    url: '/v1/admin/model-configs/llm',
    headers: adminHeaders(),
    payload: {
      name: 'backup',
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-backup',
      purpose: 'content',
      apiKey: 'sk-second-key-654321',
      isDefault: true,
    },
  })
  assert.equal(second.statusCode, 201, second.body)
  const secondId = (second.json() as { configId: string }).configId

  const list = await app.inject({ method: 'GET', url: '/v1/admin/model-configs/llm', headers: adminHeaders() })
  const configs = (list.json() as { configId: string; isDefault: boolean; apiKeyMasked: string }[])
  assert.equal(configs.length, 2)
  const defaults = configs.filter(config => config.isDefault)
  assert.deepEqual(defaults.map(config => config.configId), [secondId])
  assert.equal(list.body.includes('sk-second-key-654321'), false)

  const anthropic = await app.inject({
    method: 'POST',
    url: '/v1/admin/model-configs/llm',
    headers: adminHeaders(),
    payload: {
      name: 'anthropic-content',
      provider: 'anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      model: 'claude-test',
      purpose: 'content',
      apiKey: 'sk-ant-contract-123456',
    },
  })
  assert.equal(anthropic.statusCode, 201, anthropic.body)
  const anthropicBody = anthropic.json() as { configId: string; protocol: string; baseUrl: string }
  assert.equal(anthropicBody.protocol, 'anthropic')
  assert.equal(anthropicBody.baseUrl, 'https://api.anthropic.com')

  const switchedProtocol = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/model-configs/llm/${anthropicBody.configId}`,
    headers: adminHeaders(),
    payload: { protocol: 'openai' },
  })
  assert.equal(switchedProtocol.statusCode, 200, switchedProtocol.body)
  assert.equal((switchedProtocol.json() as { protocol: string }).protocol, 'openai')

  const badProtocol = await app.inject({
    method: 'POST',
    url: '/v1/admin/model-configs/llm',
    headers: adminHeaders(),
    payload: {
      name: 'bad-protocol',
      provider: 'openai',
      protocol: 'gemini',
      baseUrl: 'https://api.example.com',
      model: 'm',
      purpose: 'content',
    },
  })
  assert.equal(badProtocol.statusCode, 400)

  const anthropicEmbedding = await app.inject({
    method: 'POST',
    url: '/v1/admin/model-configs/llm',
    headers: adminHeaders(),
    payload: {
      name: 'bad-embedding',
      provider: 'anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'm',
      purpose: 'embedding',
    },
  })
  assert.equal(anthropicEmbedding.statusCode, 400)

  const patched = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/model-configs/llm/${first.configId}`,
    headers: adminHeaders(),
    payload: { apiKey: '', name: 'primary-renamed' },
  })
  assert.equal(patched.statusCode, 200, patched.body)
  const patchedBody = patched.json() as { name: string; apiKeyConfigured: boolean; apiKeyMasked: string }
  assert.equal(patchedBody.name, 'primary-renamed')
  assert.equal(patchedBody.apiKeyConfigured, true)
  assert.equal(patchedBody.apiKeyMasked, 'sk-c********3456')

  const embedding = await app.inject({
    method: 'POST',
    url: '/v1/admin/model-configs/llm',
    headers: adminHeaders(),
    payload: {
      name: 'embed',
      provider: 'openai',
      baseUrl: 'https://api.example.com',
      model: 'embed-test',
      purpose: 'embedding',
      isDefault: true,
    },
  })
  assert.equal(embedding.statusCode, 201, embedding.body)
  const embeddingBody = embedding.json() as { apiKeyConfigured: boolean; apiKeyMasked: string | null; isDefault: boolean }
  assert.equal(embeddingBody.apiKeyConfigured, false)
  assert.equal(embeddingBody.apiKeyMasked, null)
  assert.equal(embeddingBody.isDefault, true)

  const switched = await app.inject({
    method: 'POST',
    url: `/v1/admin/model-configs/llm/${first.configId}/set-default`,
    headers: adminHeaders(),
  })
  assert.equal(switched.statusCode, 200, switched.body)
  assert.equal((switched.json() as { isDefault: boolean }).isDefault, true)

  const badId = await app.inject({ method: 'GET', url: '/v1/admin/model-configs/llm/nope', headers: adminHeaders() })
  assert.equal(badId.statusCode, 400)
  const missing = await app.inject({
    method: 'GET',
    url: '/v1/admin/model-configs/llm/llmc_0123456789abcdef',
    headers: adminHeaders(),
  })
  assert.equal(missing.statusCode, 404)
  const missingTest = await app.inject({
    method: 'POST',
    url: '/v1/admin/model-configs/llm/llmc_0123456789abcdef/test',
    headers: adminHeaders(),
  })
  assert.equal(missingTest.statusCode, 404)

  const image = await app.inject({
    method: 'POST',
    url: '/v1/admin/model-configs/llm',
    headers: adminHeaders(),
    payload: {
      name: 'ark-image',
      provider: 'ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seedream-5-0-260128',
      purpose: 'image',
      apiKey: 'ark-contract-key-123456',
      isDefault: true,
      imagePriceMicros: 150000,
    },
  })
  assert.equal(image.statusCode, 201, image.body)
  const imageBody = image.json() as { configId: string; purpose: string; imagePriceMicros: number; isDefault: boolean }
  assert.equal(imageBody.purpose, 'image')
  assert.equal(imageBody.imagePriceMicros, 150000)
  assert.equal(imageBody.isDefault, true)
  assert.equal(image.body.includes('ark-contract-key-123456'), false)

  const defaultImagePrice = await app.inject({
    method: 'POST',
    url: '/v1/admin/model-configs/llm',
    headers: adminHeaders(),
    payload: {
      name: 'ark-image-default-price',
      provider: 'ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seedream-5-0-260128',
      purpose: 'image',
    },
  })
  assert.equal(defaultImagePrice.statusCode, 201, defaultImagePrice.body)
  assert.equal((defaultImagePrice.json() as { imagePriceMicros: number }).imagePriceMicros, 120000)

  for (const payload of [
    {
      name: 'x',
      provider: 'anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.example.com',
      model: 'm',
      purpose: 'image',
    },
    { name: 'x', provider: 'openai', baseUrl: 'not-a-url', model: 'm', purpose: 'content' },
    { name: '', provider: 'openai', baseUrl: 'https://api.example.com', model: 'm', purpose: 'content' },
    { name: 'x', provider: 'bad provider', baseUrl: 'https://api.example.com', model: 'm', purpose: 'content' },
  ]) {
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/admin/model-configs/llm',
      headers: adminHeaders(),
      payload,
    })
    assert.equal(invalid.statusCode, 400, JSON.stringify(payload))
  }

  for (const configId of [
    (defaultImagePrice.json() as { configId: string }).configId,
    imageBody.configId,
    secondId,
  ]) {
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/model-configs/llm/${configId}`,
      headers: adminHeaders(),
    })
    assert.equal(removed.statusCode, 204)
  }

  const afterDelete = await app.inject({
    method: 'GET',
    url: `/v1/admin/model-configs/llm/${secondId}`,
    headers: adminHeaders(),
  })
  assert.equal(afterDelete.statusCode, 404)
})

test('模型配置：ASR 单行配置、默认值与密钥掩码', async () => {
  const initial = await app.inject({ method: 'GET', url: '/v1/admin/model-configs/asr', headers: adminHeaders() })
  assert.equal(initial.statusCode, 200, initial.body)
  const defaults = initial.json() as {
    provider: string
    protocol: string
    baseUrl: string
    model: string
    apiKeyConfigured: boolean
    apiKeyMasked: string | null
    enabled: boolean
  }
  assert.equal(defaults.provider, 'minimax')
  assert.equal(defaults.protocol, 'minimax')
  assert.equal(defaults.baseUrl, 'https://api.minimaxi.com')
  assert.equal(defaults.apiKeyConfigured, false)
  assert.equal(defaults.apiKeyMasked, null)
  assert.equal(defaults.enabled, false)

  const updated = await app.inject({
    method: 'PATCH',
    url: '/v1/admin/model-configs/asr',
    headers: adminHeaders(),
    payload: {
      protocol: 'openai',
      baseUrl: 'https://asr.example.com/v1/audio/transcriptions',
      model: 'whisper-test',
      apiKey: 'asr-contract-key-123456',
      enabled: true,
    },
  })
  assert.equal(updated.statusCode, 200, updated.body)
  const body = updated.json() as {
    protocol: string
    baseUrl: string
    model: string
    apiKeyConfigured: boolean
    apiKeyMasked: string
    enabled: boolean
  }
  assert.equal(body.protocol, 'openai')
  assert.equal(body.baseUrl, 'https://asr.example.com')
  assert.equal(body.model, 'whisper-test')
  assert.equal(body.apiKeyConfigured, true)
  assert.equal(body.apiKeyMasked, 'asr-********3456')
  assert.equal(body.enabled, true)
  assert.equal(updated.body.includes('asr-contract-key-123456'), false)

  const kept = await app.inject({
    method: 'PATCH',
    url: '/v1/admin/model-configs/asr',
    headers: adminHeaders(),
    payload: { apiKey: '', model: 'whisper-kept' },
  })
  assert.equal(kept.statusCode, 200, kept.body)
  const keptBody = kept.json() as { model: string; apiKeyConfigured: boolean; apiKeyMasked: string }
  assert.equal(keptBody.model, 'whisper-kept')
  assert.equal(keptBody.apiKeyConfigured, true)
  assert.equal(keptBody.apiKeyMasked, 'asr-********3456')

  const invalid = await app.inject({
    method: 'PATCH',
    url: '/v1/admin/model-configs/asr',
    headers: adminHeaders(),
    payload: { protocol: 'whisper' },
  })
  assert.equal(invalid.statusCode, 400)
})
