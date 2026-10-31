import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { parse as parseYaml } from 'yaml'
import { buildApp } from '../src/app.js'
import type { Grant } from '../src/auth/service.js'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { runMigrations } from '../src/migrate.js'
import { signPlaybackToken } from '../src/playback/sign.js'
import { seedDatabase } from '../src/seed.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://trend_coach:trend_coach@127.0.0.1:5432/trend_coach_test'
const CONSOLE_TOKEN = 'test-console-token-1234'
const MEDIA_SECRET = 'test-media-signing-secret-1234'
const MEDIA_BASE_URL = 'http://127.0.0.1:3939/media'
const SEGMENT_ID = 'seg-tc101-m1-kp1-1'

const pool = createPool(DATABASE_URL)
let mediaDir = ''
let app: FastifyInstance
let routes: string[] = []
let mainGrant: Grant

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: 'local',
    DATABASE_URL,
    LOG_LEVEL: 'silent',
    CONSOLE_TOKEN,
    MEDIA_SIGNING_SECRET: MEDIA_SECRET,
    MEDIA_LOCAL_DIR: mediaDir,
    MEDIA_BASE_URL,
    SEARCH_MIN_SIMILARITY: '0.01',
    RATE_LIMIT_SEARCH_PER_MINUTE: '1000',
    RATE_LIMIT_DEVICE_CODE_PER_MINUTE: '1000',
    RATE_LIMIT_EVENTS_PER_MINUTE: '1000',
    ...overrides,
  }
}

function authHeaders(grant: Grant): Record<string, string> {
  return { authorization: `Bearer ${grant.accessToken}`, 'x-device-id': grant.deviceId }
}

async function grantFor(deviceId: string, displayName = '测试学员'): Promise<Grant> {
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
    headers: { 'x-console-token': CONSOLE_TOKEN },
    payload: { userCode, displayName },
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
    onRoute: (method, url) => routes.push(`${method} ${url}`),
  })
  await app.ready()

  mainGrant = await grantFor('device-main-0001')
})

after(async () => {
  await app.close()
  await pool.end()
  await rm(mediaDir, { recursive: true, force: true })
})

test('GET /health 报告数据库可用', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { ok: true })
})

test('OpenAPI 与注册路由双向一致', async () => {
  const document = parseYaml(
    await readFile(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8'),
  ) as { paths: Record<string, Record<string, unknown>> }
  const documented = new Set<string>()
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) documented.add(`${method.toUpperCase()} ${path}`)
  }
  const registered = new Set(
    routes
      .map(route => route.replace(/:([A-Za-z0-9_]+)/g, '{$1}'))
      // HEAD 由 GET 自动注册；/device 与 /media/* 是本地运维入口，不对外发布契约。
      .filter(route => !route.startsWith('HEAD '))
      .filter(route => route !== 'OPTIONS *')
      .filter(route => !route.endsWith(' /device'))
      .filter(route => !route.includes(' /media/')),
  )
  assert.deepEqual([...registered].sort(), [...documented].sort())
})

test('设备码：待批准、错误控制台令牌、批准、重复轮询', async () => {
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

  const badToken = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/approve',
    headers: { 'x-console-token': 'wrong-console-token' },
    payload: { userCode },
  })
  assert.equal(badToken.statusCode, 401)

  const badCode = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/approve',
    headers: { 'x-console-token': CONSOLE_TOKEN },
    payload: { userCode: 'ZZZZ-ZZZZ' },
  })
  assert.equal(badCode.statusCode, 404)

  const pending = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode } })
  assert.deepEqual(pending.json(), { status: 'pending' })

  const approved = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/approve',
    headers: { 'x-console-token': CONSOLE_TOKEN },
    payload: { userCode },
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

  const cases: Record<string, unknown>[] = [
    { eventId: 'evt-contract-0002', name: 'answer_generated', props: {} },
    { ...event, eventId: 'evt-contract-0003', props: { ...event.props, query: '均线' } },
    { eventId: 'evt-contract-0004', name: 'citation_clicked', props: { segmentId: 'bad' } },
    { ...event, eventId: 'evt-contract-0005', occurredAt: Date.now() - 31 * 24 * 60 * 60 * 1000 },
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
