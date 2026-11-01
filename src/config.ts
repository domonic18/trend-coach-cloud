import { resolve } from 'node:path'

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

export interface AsrConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

export interface PipelineConfig {
  enabled: true
  storageDir: string
  hlsDir: string
  ffmpegPath: string
  ffprobePath: string
  maxUploadBytes: number
  maxSourceSeconds: number
  maxConcurrentJobs: number
  asrConcurrency: number
  llmConcurrency: number
  pollIntervalMs: number
  heartbeatMs: number
  staleJobMs: number
  maxAttempts: number
  ffmpegTimeoutMs: number
  audioTimeoutMs: number
  transcriptSegmentMaxSec: number
  segmentDraftMaxSec: number
  generationWindowSec: number
  generationMinConfidence: number
  generationMaxWindows: number
  generationMaxKps: number
  generationMaxArticles: number
}

export interface LlmConfig {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs: number
  temperature: number
  maxTokens: number
  maxInputChars: number
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
  asr?: AsrConfig
  asrLongTimeoutMs: number
  pipeline?: PipelineConfig
  llm?: LlmConfig
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
  rateLimitAsrPerMinute: number
  rateLimitPipelinePerMinute: number
  rateLimitDeviceTokenPerMinute: number
  rateLimitRefreshPerMinute: number
  rateLimitCatalogPerMinute: number
  rateLimitContentPerMinute: number
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

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  fail(`${key} 必须是 true/false`)
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

  const asrBaseRaw = text(env, 'ASR_BASE_URL')
  const asrApiKey = text(env, 'ASR_API_KEY')
  if (asrBaseRaw !== undefined && asrApiKey === undefined) {
    fail('ASR_BASE_URL 显式设置时必须配置 ASR_API_KEY')
  }
  if (appEnv !== 'local' && asrApiKey === undefined) fail(`ASR_API_KEY 在 ${appEnv} 必填`)
  const asr: AsrConfig | undefined = asrApiKey === undefined
    ? undefined
    : {
        baseUrl: (asrBaseRaw === undefined
          ? 'https://api.minimaxi.com'
          : parseUrl('ASR_BASE_URL', asrBaseRaw, appEnv).toString()).replace(/\/+$/, ''),
        apiKey: asrApiKey,
        model: text(env, 'ASR_MODEL') ?? 'asr-1.0',
        timeoutMs: int(env, 'ASR_TIMEOUT_MS', 30_000),
      }

  const pipelineEnabled = bool(env, 'PIPELINE_ENABLED', false)
  let pipeline: PipelineConfig | undefined
  if (pipelineEnabled) {
    const storageRaw = text(env, 'PIPELINE_STORAGE_DIR') ?? fail('PIPELINE_STORAGE_DIR 在启用管线时必填')
    const hlsRaw = text(env, 'PIPELINE_HLS_DIR') ?? fail('PIPELINE_HLS_DIR 在启用管线时必填')
    const storageDir = resolve(storageRaw)
    const hlsDir = resolve(hlsRaw)
    if (storageDir === hlsDir) fail('PIPELINE_STORAGE_DIR 与 PIPELINE_HLS_DIR 不能相同')
    if (mediaLocalDir !== undefined && hlsDir !== resolve(mediaLocalDir)) {
      fail('PIPELINE_HLS_DIR 必须与 MEDIA_LOCAL_DIR 相同')
    }
    const heartbeatMs = int(env, 'PIPELINE_HEARTBEAT_MS', 10_000, { min: 1000 })
    const staleJobMs = int(env, 'PIPELINE_STALE_JOB_MS', 120_000, { min: 1000 })
    if (staleJobMs <= heartbeatMs) fail('PIPELINE_STALE_JOB_MS 必须大于 PIPELINE_HEARTBEAT_MS')
    const generationMinConfidence = float(env, 'GENERATION_MIN_CONFIDENCE', 0.6)
    if (generationMinConfidence < 0 || generationMinConfidence > 1) {
      fail('GENERATION_MIN_CONFIDENCE 必须在 0–1 之间')
    }
    pipeline = {
      enabled: true,
      storageDir,
      hlsDir,
      ffmpegPath: text(env, 'FFMPEG_PATH') ?? 'ffmpeg',
      ffprobePath: text(env, 'FFPROBE_PATH') ?? 'ffprobe',
      maxUploadBytes: int(env, 'PIPELINE_MAX_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024, { min: 1024 }),
      maxSourceSeconds: int(env, 'PIPELINE_MAX_SOURCE_SECONDS', 4 * 60 * 60, { min: 1 }),
      maxConcurrentJobs: int(env, 'PIPELINE_MAX_CONCURRENT_JOBS', 1, { max: 16 }),
      asrConcurrency: int(env, 'PIPELINE_ASR_CONCURRENCY', 2, { max: 16 }),
      llmConcurrency: int(env, 'PIPELINE_LLM_CONCURRENCY', 2, { max: 16 }),
      pollIntervalMs: int(env, 'PIPELINE_POLL_INTERVAL_MS', 2000, { min: 100 }),
      heartbeatMs,
      staleJobMs,
      maxAttempts: int(env, 'PIPELINE_MAX_ATTEMPTS', 3, { max: 10 }),
      ffmpegTimeoutMs: int(env, 'PIPELINE_FFMPEG_TIMEOUT_MS', 2 * 60 * 60 * 1000, { min: 1000 }),
      audioTimeoutMs: int(env, 'PIPELINE_AUDIO_TIMEOUT_MS', 10 * 60 * 1000, { min: 1000 }),
      transcriptSegmentMaxSec: int(env, 'TRANSCRIPT_SEGMENT_MAX_SEC', 30, { max: 480 }),
      segmentDraftMaxSec: int(env, 'SEGMENT_DRAFT_MAX_SEC', 120, { max: 600 }),
      generationWindowSec: int(env, 'GENERATION_WINDOW_SEC', 600, { min: 60 }),
      generationMinConfidence,
      generationMaxWindows: int(env, 'GENERATION_MAX_WINDOWS', 24, { max: 200 }),
      generationMaxKps: int(env, 'GENERATION_MAX_KPS', 80, { max: 500 }),
      generationMaxArticles: int(env, 'GENERATION_MAX_ARTICLES', 80, { max: 500 }),
    }
  }

  const llmBaseRaw = text(env, 'CONTENT_LLM_BASE_URL')
  const llmModel = text(env, 'CONTENT_LLM_MODEL')
  if ((llmBaseRaw === undefined) !== (llmModel === undefined)) {
    fail('CONTENT_LLM_BASE_URL 与 CONTENT_LLM_MODEL 必须同时配置')
  }
  let llm: LlmConfig | undefined
  if (llmBaseRaw !== undefined && llmModel !== undefined) {
    const baseUrl = parseUrl('CONTENT_LLM_BASE_URL', llmBaseRaw, appEnv)
    const apiKey = text(env, 'CONTENT_LLM_API_KEY')
    if (appEnv !== 'local' && !isLoopback(baseUrl.hostname) && apiKey === undefined) {
      fail(`CONTENT_LLM_API_KEY 在 ${appEnv} 必填`)
    }
    const temperature = float(env, 'CONTENT_LLM_TEMPERATURE', 0.2)
    if (temperature < 0 || temperature > 2) fail('CONTENT_LLM_TEMPERATURE 必须在 0–2 之间')
    llm = {
      baseUrl: baseUrl.toString().replace(/\/+$/, ''),
      model: llmModel,
      ...(apiKey === undefined ? {} : { apiKey }),
      timeoutMs: int(env, 'CONTENT_LLM_TIMEOUT_MS', 120_000, { min: 1000 }),
      temperature,
      maxTokens: int(env, 'CONTENT_LLM_MAX_TOKENS', 8192, { max: 1_000_000 }),
      maxInputChars: int(env, 'CONTENT_LLM_MAX_INPUT_CHARS', 120_000, { min: 1000 }),
    }
  }

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
    asrLongTimeoutMs: int(env, 'ASR_LONG_TIMEOUT_MS', 600_000, { min: 1000 }),
    ...(asr === undefined ? {} : { asr }),
    ...(pipeline === undefined ? {} : { pipeline }),
    ...(llm === undefined ? {} : { llm }),
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
    rateLimitAsrPerMinute: int(env, 'RATE_LIMIT_ASR_PER_MINUTE', 20),
    rateLimitPipelinePerMinute: int(env, 'RATE_LIMIT_PIPELINE_PER_MINUTE', 30),
    rateLimitDeviceTokenPerMinute: int(env, 'RATE_LIMIT_DEVICE_TOKEN_PER_MINUTE', 120),
    rateLimitRefreshPerMinute: int(env, 'RATE_LIMIT_REFRESH_PER_MINUTE', 60),
    rateLimitCatalogPerMinute: int(env, 'RATE_LIMIT_CATALOG_PER_MINUTE', 240),
    rateLimitContentPerMinute: int(env, 'RATE_LIMIT_CONTENT_PER_MINUTE', 300),
  }
}
