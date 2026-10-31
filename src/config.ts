export const APP_ENVS = ['local', 'staging', 'production'] as const
export type AppEnv = (typeof APP_ENVS)[number]

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug', 'trace'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const LOCAL_METRICS_TOKEN = 'local-metrics-token'
const LOCAL_MEDIA_SECRET = 'local-media-signing-secret'
const USERNAME = /^[a-z][a-z0-9._-]{2,31}$/

export interface EmbeddingConfig {
  baseUrl: string
  model: string
  apiKey?: string
}

export interface AppConfig {
  env: AppEnv
  host: string
  port: number
  publicBaseUrl: string
  databaseUrl: string
  logLevel: LogLevel
  accessTtlSec: number
  refreshTtlSec: number
  deviceCodeTtlSec: number
  devicePollIntervalSec: number
  playbackSessionTtlSec: number
  playbackMaxConcurrent: number
  mediaBaseUrl: string
  mediaSigningSecret: string
  mediaLocalDir?: string
  metricsToken: string
  sessionTtlSec: number
  inviteTtlSec: number
  bootstrapAdmin?: { username: string; password: string }
  embedding?: EmbeddingConfig
  searchMinSimilarity: number
  searchMinConfidence: number
  rrfK: number
  rateLimitSearchPerMinute: number
  rateLimitDeviceCodePerMinute: number
  rateLimitEventsPerMinute: number
  rateLimitProgressPerMinute: number
  rateLimitLoginPerMinute: number
  rateLimitInvitePerMinute: number
  rateLimitDeviceApprovePerMinute: number
}

type Env = Record<string, string | undefined>

function fail(message: string): never {
  throw new Error(`config: ${message}`)
}

function int(env: Env, key: string, fallback: number, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${key} 必须是 ${min}–${max} 之间的整数`)
  }
  return value
}

function float(env: Env, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) fail(`${key} 必须是数字`)
  return value
}

function text(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim()
  return raw === '' ? undefined : raw
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '::1'
    || hostname === '[::1]'
    || hostname === '0.0.0.0'
    || /^127\./.test(hostname)
}

function parseUrl(key: string, raw: string, env: AppEnv): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail(`${key} 不是合法 URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(`${key} 仅支持 http/https`)
  if (url.username !== '' || url.password !== '') fail(`${key} 不得包含账号密码`)
  if (url.search !== '' || url.hash !== '') fail(`${key} 不得包含查询串或锚点`)
  if (env !== 'local' && url.protocol !== 'https:') fail(`${key} 在 ${env} 必须使用 HTTPS`)
  if (env === 'production' && isLoopback(url.hostname)) fail(`${key} 在 production 不允许指向本机地址`)
  return url
}

/** 启动即校验，配置错误不允许带病运行。 */
export function loadConfig(env: Env = process.env): AppConfig {
  const rawEnv = (env.APP_ENV ?? 'local').trim()
  if (!(APP_ENVS as readonly string[]).includes(rawEnv)) {
    fail(`APP_ENV 必须是 ${APP_ENVS.join('/')}`)
  }
  const appEnv = rawEnv as AppEnv

  const rawLog = (env.LOG_LEVEL ?? 'info').trim()
  if (!(LOG_LEVELS as readonly string[]).includes(rawLog)) {
    fail(`LOG_LEVEL 必须是 ${LOG_LEVELS.join('/')}`)
  }

  const databaseUrl = text(env, 'DATABASE_URL') ?? fail('DATABASE_URL 必填')
  const port = int(env, 'PORT', 3939, { max: 65535 })
  const publicBaseUrl = parseUrl('PUBLIC_BASE_URL', text(env, 'PUBLIC_BASE_URL') ?? 'http://127.0.0.1:3939', appEnv)
  const defaultMediaBase = appEnv === 'local'
    ? `${publicBaseUrl.toString().replace(/\/+$/, '')}/media`
    : publicBaseUrl.origin
  const mediaBaseUrl = parseUrl('MEDIA_BASE_URL', text(env, 'MEDIA_BASE_URL') ?? defaultMediaBase, appEnv)

  const metricsToken = text(env, 'METRICS_TOKEN') ?? (appEnv === 'local' ? LOCAL_METRICS_TOKEN : fail('METRICS_TOKEN 必填'))
  if (metricsToken.length < 16) fail('METRICS_TOKEN 至少 16 个字符')
  if (appEnv !== 'local' && metricsToken === LOCAL_METRICS_TOKEN) fail('METRICS_TOKEN 不得使用本地默认值')

  const bootstrapUsername = text(env, 'BOOTSTRAP_ADMIN_USERNAME')
  const bootstrapPassword = text(env, 'BOOTSTRAP_ADMIN_PASSWORD')
  if ((bootstrapUsername === undefined) !== (bootstrapPassword === undefined)) {
    fail('BOOTSTRAP_ADMIN_USERNAME 与 BOOTSTRAP_ADMIN_PASSWORD 必须同时配置')
  }
  let bootstrapAdmin: { username: string; password: string } | undefined
  if (bootstrapUsername !== undefined && bootstrapPassword !== undefined) {
    if (!USERNAME.test(bootstrapUsername)) fail('BOOTSTRAP_ADMIN_USERNAME 必须匹配 [a-z][a-z0-9._-]{2,31}')
    if (bootstrapPassword.length < 12) fail('BOOTSTRAP_ADMIN_PASSWORD 至少 12 个字符')
    bootstrapAdmin = { username: bootstrapUsername, password: bootstrapPassword }
  }

  const mediaSigningSecret = text(env, 'MEDIA_SIGNING_SECRET') ?? (appEnv === 'local' ? LOCAL_MEDIA_SECRET : fail('MEDIA_SIGNING_SECRET 必填'))
  if (mediaSigningSecret.length < 16) fail('MEDIA_SIGNING_SECRET 至少 16 个字符')
  if (appEnv !== 'local' && mediaSigningSecret === LOCAL_MEDIA_SECRET) fail('MEDIA_SIGNING_SECRET 不得使用本地默认值')

  const mediaLocalDir = text(env, 'MEDIA_LOCAL_DIR')
  const embeddingUrl = text(env, 'EMBEDDING_BASE_URL')
  const embeddingModel = text(env, 'EMBEDDING_MODEL')
  if ((embeddingUrl === undefined) !== (embeddingModel === undefined)) {
    fail('EMBEDDING_BASE_URL 与 EMBEDDING_MODEL 必须同时配置')
  }
  const embedding = embeddingUrl === undefined || embeddingModel === undefined
    ? undefined
    : (() => {
        parseUrl('EMBEDDING_BASE_URL', embeddingUrl, appEnv)
        const apiKey = text(env, 'EMBEDDING_API_KEY')
        return apiKey === undefined
          ? { baseUrl: embeddingUrl.replace(/\/+$/, ''), model: embeddingModel }
          : { baseUrl: embeddingUrl.replace(/\/+$/, ''), model: embeddingModel, apiKey }
      })()

  const searchMinSimilarity = float(env, 'SEARCH_MIN_SIMILARITY', 0.05)
  const searchMinConfidence = float(env, 'SEARCH_MIN_CONFIDENCE', 0.15)
  if (searchMinSimilarity < 0 || searchMinSimilarity > 1) fail('SEARCH_MIN_SIMILARITY 必须在 0–1 之间')
  if (searchMinConfidence < 0 || searchMinConfidence > 1) fail('SEARCH_MIN_CONFIDENCE 必须在 0–1 之间')
  if (searchMinConfidence < searchMinSimilarity) fail('SEARCH_MIN_CONFIDENCE 不能低于 SEARCH_MIN_SIMILARITY')

  return {
    env: appEnv,
    host: text(env, 'HOST') ?? '127.0.0.1',
    port,
    publicBaseUrl: publicBaseUrl.toString().replace(/\/+$/, ''),
    databaseUrl,
    logLevel: rawLog as LogLevel,
    accessTtlSec: int(env, 'ACCESS_TTL_SECONDS', 900),
    refreshTtlSec: int(env, 'REFRESH_TTL_SECONDS', 30 * 24 * 60 * 60),
    deviceCodeTtlSec: int(env, 'DEVICE_CODE_TTL_SECONDS', 300),
    devicePollIntervalSec: int(env, 'DEVICE_POLL_INTERVAL_SECONDS', 2, { min: 1 }),
    playbackSessionTtlSec: int(env, 'PLAYBACK_SESSION_TTL_SECONDS', 600, { min: 60 }),
    playbackMaxConcurrent: int(env, 'PLAYBACK_MAX_CONCURRENT', 5),
    mediaBaseUrl: mediaBaseUrl.toString().replace(/\/+$/, ''),
    mediaSigningSecret,
    ...(mediaLocalDir === undefined ? {} : { mediaLocalDir }),
    metricsToken,
    sessionTtlSec: int(env, 'SESSION_TTL_SECONDS', 12 * 60 * 60, { min: 300 }),
    inviteTtlSec: int(env, 'INVITE_TTL_SECONDS', 7 * 24 * 60 * 60, { min: 3600 }),
    ...(bootstrapAdmin === undefined ? {} : { bootstrapAdmin }),
    ...(embedding === undefined ? {} : { embedding }),
    searchMinSimilarity,
    searchMinConfidence,
    rrfK: int(env, 'RRF_K', 60),
    rateLimitSearchPerMinute: int(env, 'RATE_LIMIT_SEARCH_PER_MINUTE', 120),
    rateLimitDeviceCodePerMinute: int(env, 'RATE_LIMIT_DEVICE_CODE_PER_MINUTE', 10),
    rateLimitEventsPerMinute: int(env, 'RATE_LIMIT_EVENTS_PER_MINUTE', 120),
    rateLimitProgressPerMinute: int(env, 'RATE_LIMIT_PROGRESS_PER_MINUTE', 120),
    rateLimitLoginPerMinute: int(env, 'RATE_LIMIT_LOGIN_PER_MINUTE', 10),
    rateLimitInvitePerMinute: int(env, 'RATE_LIMIT_INVITE_PER_MINUTE', 10),
    rateLimitDeviceApprovePerMinute: int(env, 'RATE_LIMIT_DEVICE_APPROVE_PER_MINUTE', 10),
  }
}
