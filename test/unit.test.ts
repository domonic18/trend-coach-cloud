import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { hashPassword, verifyPassword } from '../src/accounts/password.js'
import { loadConfig } from '../src/config.js'
import { parseEventBody } from '../src/events/service.js'
import { fuse, parseSearchBody, type Candidate, type SegmentRow } from '../src/kb/service.js'
import { parseRange } from '../src/media/range.js'
import { signPlaybackToken, verifyPlaybackToken } from '../src/playback/sign.js'
import { RateLimiter } from '../src/rate-limit.js'

const baseEnv = {
  APP_ENV: 'local',
  DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/db',
  LOG_LEVEL: 'silent',
  METRICS_TOKEN: '0123456789abcdef',
  MEDIA_SIGNING_SECRET: '0123456789abcdef',
}

test('local 配置允许 http，媒体地址默认带 /media', () => {
  const config = loadConfig(baseEnv)
  assert.equal(config.env, 'local')
  assert.equal(config.publicBaseUrl, 'http://127.0.0.1:3939')
  assert.equal(config.mediaBaseUrl, 'http://127.0.0.1:3939/media')
})

test('staging/production 强制 HTTPS；production 拒绝本机地址', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, APP_ENV: 'staging', PUBLIC_BASE_URL: 'http://api.example.com' }),
    /HTTPS/,
  )
  assert.throws(
    () => loadConfig({ ...baseEnv, APP_ENV: 'production', PUBLIC_BASE_URL: 'https://127.0.0.1' }),
    /本机地址/,
  )
  const config = loadConfig({
    ...baseEnv,
    APP_ENV: 'production',
    PUBLIC_BASE_URL: 'https://api.example.com',
    MEDIA_BASE_URL: 'https://media.example.com',
    ASR_API_KEY: 'test-asr-key',
  })
  assert.equal(config.env, 'production')
  assert.equal(config.asr?.apiKey, 'test-asr-key')
})

test('staging/production 拒绝本地默认密钥', () => {
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      APP_ENV: 'staging',
      PUBLIC_BASE_URL: 'https://api.example.com',
      METRICS_TOKEN: 'local-metrics-token',
    }),
    /METRICS_TOKEN/,
  )
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      APP_ENV: 'staging',
      PUBLIC_BASE_URL: 'https://api.example.com',
      MEDIA_SIGNING_SECRET: 'local-media-signing-secret',
    }),
    /MEDIA_SIGNING_SECRET/,
  )
})

test('非法枚举、TTL 与 URL 被拒绝', () => {
  assert.throws(() => loadConfig({ ...baseEnv, APP_ENV: 'dev' }), /APP_ENV/)
  assert.throws(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'trace2' }), /LOG_LEVEL/)
  assert.throws(() => loadConfig({ ...baseEnv, ACCESS_TTL_SECONDS: '0' }), /ACCESS_TTL_SECONDS/)
  assert.throws(() => loadConfig({ ...baseEnv, DATABASE_URL: '' }), /DATABASE_URL/)
  assert.throws(() => loadConfig({ ...baseEnv, PUBLIC_BASE_URL: 'ftp://api.example.com' }), /http\/https/)
  assert.throws(() => loadConfig({ ...baseEnv, PUBLIC_BASE_URL: 'https://user:pass@api.example.com' }), /账号密码/)
  assert.throws(() => loadConfig({ ...baseEnv, PUBLIC_BASE_URL: 'https://api.example.com?x=1' }), /查询串/)
})

test('检索阈值必须在 0–1 且置信阈值不低于召回阈值', () => {
  assert.equal(loadConfig(baseEnv).searchMinConfidence, 0.15)
  assert.throws(() => loadConfig({ ...baseEnv, SEARCH_MIN_SIMILARITY: '-0.1' }), /SEARCH_MIN_SIMILARITY/)
  assert.throws(() => loadConfig({ ...baseEnv, SEARCH_MIN_CONFIDENCE: '1.2' }), /SEARCH_MIN_CONFIDENCE/)
  assert.throws(
    () => loadConfig({ ...baseEnv, SEARCH_MIN_SIMILARITY: '0.3', SEARCH_MIN_CONFIDENCE: '0.2' }),
    /不能低于/,
  )
})

test('embedding 必须成对配置', () => {
  assert.throws(() => loadConfig({ ...baseEnv, EMBEDDING_BASE_URL: 'https://embed.example.com/v1' }), /同时配置/)
  const config = loadConfig({
    ...baseEnv,
    EMBEDDING_BASE_URL: 'https://embed.example.com/v1/',
    EMBEDDING_MODEL: 'text-embedding-3-large',
  })
  assert.equal(config.embedding?.baseUrl, 'https://embed.example.com/v1')
})

test('search 入参：trim、长度、topK、courseId', () => {
  assert.deepEqual(parseSearchBody({ query: '  均线  ' }), { query: '均线', topK: 5 })
  assert.equal(parseSearchBody({ query: '均线', topK: 20 }).topK, 20)
  assert.throws(() => parseSearchBody({ query: '好'.repeat(501) }), /1–500/)
  assert.throws(() => parseSearchBody({ query: '   ' }), /1–500/)
  assert.throws(() => parseSearchBody({ query: '均线', topK: 0 }), /topK/)
  assert.throws(() => parseSearchBody({ query: '均线', topK: 21 }), /topK/)
  assert.throws(() => parseSearchBody({ query: '均线', topK: 1.5 }), /topK/)
  assert.throws(() => parseSearchBody({ query: '均线', courseId: 'bad course' }), /courseId/)
  assert.throws(() => parseSearchBody([]), /JSON object/)
})

test('RRF 融合：双列表按名次累加并归一到 [0,1]', () => {
  const row = (id: string): SegmentRow => ({ segment_id: id } as SegmentRow)
  const list = (ids: string[]): Candidate[] => ids.map(id => ({ row: row(id), score: 0.5 }))
  const fused = fuse([list(['a', 'b']), list(['b'])], 60)
  assert.equal(fused.get('a')?.score, 0.5)
  assert.equal(fused.get('b')?.score?.toFixed(4), '0.9919')
  const single = fuse([list(['a', 'b'])], 60)
  assert.equal(single.get('a')?.score, 1)
  assert.equal(single.get('b')?.score?.toFixed(4), '0.9839')
  assert.equal(fuse([[], []], 60).size, 0)
})

test('Range 解析：单段、后缀、越界、多段', () => {
  assert.equal(parseRange(undefined, 100), undefined)
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=0-999', 100), { start: 0, end: 99 })
  assert.equal(parseRange('bytes=100-', 100), 'invalid')
  assert.equal(parseRange('bytes=20-10', 100), 'invalid')
  assert.equal(parseRange('bytes=0-1,3-4', 100), 'invalid')
  assert.equal(parseRange('bytes=-0', 100), 'invalid')
})

test('限流器：固定窗口、过期清理与键数上限', () => {
  let now = 0
  const limiter = new RateLimiter(() => now, 60_000, 2)
  assert.equal(limiter.take('a', 1), true)
  assert.equal(limiter.take('a', 1), false)
  assert.equal(limiter.take('b', 1), true)
  assert.equal(limiter.take('c', 1), false)
  now = 60_000
  assert.equal(limiter.take('c', 1), true)
  assert.equal(limiter.take('a', 1), true)
})

test('播放签名：往返、篡改、过期与目录作用域', () => {
  const secret = 'unit-test-secret-0123456789'
  const token = signPlaybackToken(secret, { v: 1, p: 'hls/', e: Date.now() + 60_000, s: 'ps_x' })
  assert.deepEqual(verifyPlaybackToken(secret, token)?.s, 'ps_x')
  assert.equal(verifyPlaybackToken('another-secret-0123456789', token), undefined)
  assert.equal(verifyPlaybackToken(secret, `${token.slice(0, -1)}x`), undefined)
  const expired = signPlaybackToken(secret, { v: 1, p: 'hls/', e: Date.now() - 1, s: 'ps_x' })
  assert.equal(verifyPlaybackToken(secret, expired), undefined)
  const scoped = signPlaybackToken(secret, { v: 1, p: '../hls/', e: Date.now() + 60_000, s: 'ps_x' })
  assert.equal(verifyPlaybackToken(secret, scoped), undefined)
})

test('密码哈希：随机盐、可验证、格式异常失败', async () => {
  const first = await hashPassword('correct horse battery')
  const second = await hashPassword('correct horse battery')
  assert.match(first, /^scrypt\$16384\$8\$1\$/)
  assert.notEqual(first, second)
  assert.equal(await verifyPassword('correct horse battery', first), true)
  assert.equal(await verifyPassword('wrong password', first), false)
  assert.equal(await verifyPassword('correct horse battery', null), false)
  assert.equal(await verifyPassword('correct horse battery', 'bcrypt$x$y'), false)
  assert.equal(await verifyPassword('correct horse battery', 'scrypt$1$1$1$bad$bad'), false)
})

test('管理员引导配置必须成对且密码至少 12 字符', () => {
  assert.throws(() => loadConfig({ ...baseEnv, BOOTSTRAP_ADMIN_USERNAME: 'admin01' }), /同时配置/)
  assert.throws(
    () => loadConfig({ ...baseEnv, BOOTSTRAP_ADMIN_USERNAME: 'admin01', BOOTSTRAP_ADMIN_PASSWORD: 'short' }),
    /至少 12/,
  )
  assert.throws(
    () => loadConfig({ ...baseEnv, BOOTSTRAP_ADMIN_USERNAME: 'Admin01', BOOTSTRAP_ADMIN_PASSWORD: 'long-enough-password' }),
    /BOOTSTRAP_ADMIN_USERNAME/,
  )
  const config = loadConfig({
    ...baseEnv,
    BOOTSTRAP_ADMIN_USERNAME: 'admin01',
    BOOTSTRAP_ADMIN_PASSWORD: 'long-enough-password',
  })
  assert.equal(config.bootstrapAdmin?.username, 'admin01')
})

test('事件白名单：字段、名称与时间范围', () => {
  const now = Date.now()
  const event = parseEventBody({
    eventId: 'evt-00000001',
    name: 'search_requested',
    occurredAt: now,
    props: { durationMs: 120, topK: 5, hits: 3, empty: false },
  })
  assert.equal(event.name, 'search_requested')
  assert.throws(
    () => parseEventBody({
      eventId: 'evt-00000002',
      name: 'search_requested',
      props: { durationMs: 120, topK: 5, hits: 3, empty: false, query: '均线' },
    }),
    /not allowed/,
  )
  assert.throws(
    () => parseEventBody({ eventId: 'evt-00000003', name: 'answer_generated', props: {} }),
    /event name not allowed/,
  )
  assert.throws(
    () => parseEventBody({ eventId: 'evt-00000004', name: 'player_started', props: { startupMs: 10 } }),
    /autoplayBlocked/,
  )
  assert.throws(
    () => parseEventBody({
      eventId: 'evt-00000005',
      name: 'player_started',
      occurredAt: now - 31 * 24 * 60 * 60 * 1000,
      props: { startupMs: 10, autoplayBlocked: false },
    }),
    /occurredAt out of range/,
  )
})

test('管线默认关闭；启用时要求成对目录且 HLS 目录与媒体目录一致', () => {
  const disabled = loadConfig(baseEnv)
  assert.equal(disabled.pipeline, undefined)
  assert.equal(disabled.llm, undefined)
  assert.equal(disabled.asrLongTimeoutMs, 600_000)
  assert.equal(disabled.rateLimitPipelinePerMinute, 30)

  assert.throws(() => loadConfig({ ...baseEnv, PIPELINE_ENABLED: 'yes' }), /true\/false/)
  assert.throws(() => loadConfig({ ...baseEnv, PIPELINE_ENABLED: 'true' }), /PIPELINE_STORAGE_DIR/)
  assert.throws(
    () => loadConfig({ ...baseEnv, PIPELINE_ENABLED: 'true', PIPELINE_STORAGE_DIR: '/tmp/pipeline' }),
    /PIPELINE_HLS_DIR/,
  )
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      PIPELINE_ENABLED: 'true',
      PIPELINE_STORAGE_DIR: '/tmp/pipeline',
      PIPELINE_HLS_DIR: '/tmp/pipeline/',
    }),
    /不能相同/,
  )
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      MEDIA_LOCAL_DIR: '/srv/media',
      PIPELINE_ENABLED: 'true',
      PIPELINE_STORAGE_DIR: '/srv/pipeline',
      PIPELINE_HLS_DIR: '/srv/hls',
    }),
    /MEDIA_LOCAL_DIR/,
  )
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      PIPELINE_ENABLED: 'true',
      PIPELINE_STORAGE_DIR: '/tmp/pipeline',
      PIPELINE_HLS_DIR: '/tmp/hls',
      PIPELINE_HEARTBEAT_MS: '200000',
      PIPELINE_STALE_JOB_MS: '1000',
    }),
    /必须大于/,
  )

  const config = loadConfig({
    ...baseEnv,
    MEDIA_LOCAL_DIR: '/srv/media/',
    PIPELINE_ENABLED: 'true',
    PIPELINE_STORAGE_DIR: '/srv/pipeline',
    PIPELINE_HLS_DIR: '/srv/media',
    PIPELINE_MAX_UPLOAD_BYTES: '1024',
    RATE_LIMIT_PIPELINE_PER_MINUTE: '5',
  })
  assert.equal(config.pipeline?.storageDir, resolve('/srv/pipeline'))
  assert.equal(config.pipeline?.hlsDir, resolve('/srv/media'))
  assert.equal(config.pipeline?.maxUploadBytes, 1024)
  assert.equal(config.pipeline?.maxAttempts, 3)
  assert.equal(config.pipeline?.generationMinConfidence, 0.6)
  assert.equal(config.rateLimitPipelinePerMinute, 5)
})

test('内容 LLM 必须成对配置，非本机地址要求 key', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, CONTENT_LLM_BASE_URL: 'https://llm.example.com/v1' }),
    /同时配置/,
  )
  assert.throws(
    () => loadConfig({ ...baseEnv, CONTENT_LLM_MODEL: 'qwen' }),
    /同时配置/,
  )
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      APP_ENV: 'staging',
      PUBLIC_BASE_URL: 'https://api.example.com',
      ASR_API_KEY: 'test-asr-key',
      CONTENT_LLM_BASE_URL: 'https://llm.example.com/v1',
      CONTENT_LLM_MODEL: 'qwen',
    }),
    /CONTENT_LLM_API_KEY/,
  )
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      APP_ENV: 'staging',
      PUBLIC_BASE_URL: 'https://api.example.com',
      ASR_API_KEY: 'test-asr-key',
      CONTENT_LLM_BASE_URL: 'http://llm.example.com/v1',
      CONTENT_LLM_MODEL: 'qwen',
      CONTENT_LLM_API_KEY: 'llm-key',
    }),
    /HTTPS/,
  )
  const config = loadConfig({
    ...baseEnv,
    CONTENT_LLM_BASE_URL: 'https://llm.example.com/v1/',
    CONTENT_LLM_MODEL: 'qwen',
    CONTENT_LLM_API_KEY: 'llm-key',
    CONTENT_LLM_TEMPERATURE: '0.4',
  })
  assert.equal(config.llm?.baseUrl, 'https://llm.example.com/v1')
  assert.equal(config.llm?.temperature, 0.4)
  assert.equal(config.llm?.maxTokens, 8192)
})
