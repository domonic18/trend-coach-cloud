import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { AiUsageService } from '../src/ai/usage.js'
import { buildApp } from '../src/app.js'
import type { LongFormAsr } from '../src/asr/longform.js'
import type { AppConfig } from '../src/config.js'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { createMetrics, type Metrics } from '../src/metrics.js'
import { runMigrations } from '../src/migrate.js'
import type { ImageClient, GeneratedImage } from '../src/illustration/ark.js'
import { createIllustrationHook } from '../src/illustration/hook.js'
import { createFigureStore } from '../src/illustration/store.js'
import { MediaToolError } from '../src/pipeline/ffmpeg.js'
import type { LlmClient } from '../src/pipeline/llm.js'
import type { MediaProcessor } from '../src/pipeline/media-processor.js'
import { createLocalMediaStore, type MediaStore } from '../src/pipeline/media-store.js'
import { createPipelineRuntime, type PipelineRuntime } from '../src/pipeline/runtime.js'
import type { SourceProbe } from '../src/pipeline/types.js'
import { ModelConfigService, type ResolvedImage } from '../src/model-config/service.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://trend_coach:trend_coach@127.0.0.1:5432/trend_coach_test'
const ADMIN_USERNAME = 'pipeline-admin-01'
const ADMIN_PASSWORD = 'pipeline-password-123'
const METRICS_TOKEN = 'test-metrics-token-1234'
const COURSE_ID = 'T-PIPE-01'
const SOURCE = Buffer.from('fake-video-source-payload')

const pool = createPool(DATABASE_URL)
let config: AppConfig
let storageDir = ''
let hlsDir = ''
let figureDir = ''
let app: FastifyInstance
let runtime: PipelineRuntime
let store: MediaStore
let metrics: Metrics
let adminToken = ''
let imageCalls = 0
let holdProbe = false
let releaseProbe: (() => void) | null = null
let reindexCalls = 0
let reindexFails = false
const STUDENT_PASSWORD = 'pipeline-student-pass-1234'
const LEARNER_DEVICE_ID = 'pipeline-learner-device-01'

interface JobBody {
  jobId: string
  assetId: string | null
  courseId: string
  kind: string
  status: string
  stage: string
  progress: number
  attempts: number
  maxAttempts: number
  cancelRequested: boolean
  errorCode: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

interface AssetBody {
  assetId: string
  courseId: string
  title: string | null
  status: string
  durationMs: number | null
  sourceSizeBytes: number | null
  errorCode: string | null
  createdAt: number
  updatedAt: number
}

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: 'local',
    DATABASE_URL,
    LOG_LEVEL: 'silent',
    METRICS_TOKEN,
    BOOTSTRAP_ADMIN_USERNAME: ADMIN_USERNAME,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    MEDIA_SIGNING_SECRET: 'test-media-signing-secret-1234',
    MEDIA_LOCAL_DIR: hlsDir,
    MEDIA_BASE_URL: 'http://127.0.0.1:3939/media',
    PIPELINE_ENABLED: 'true',
    PIPELINE_STORAGE_DIR: storageDir,
    PIPELINE_HLS_DIR: hlsDir,
    PIPELINE_FIGURE_DIR: figureDir,
    PIPELINE_MAX_UPLOAD_BYTES: '4096',
    PIPELINE_POLL_INTERVAL_MS: '100',
    PIPELINE_HEARTBEAT_MS: '1000',
    PIPELINE_STALE_JOB_MS: '5000',
    ASR_API_KEY: 'test-asr-key',
    RATE_LIMIT_LOGIN_PER_MINUTE: '1000',
    RATE_LIMIT_PIPELINE_PER_MINUTE: '1000',
    SEARCH_MIN_SIMILARITY: '0.01',
    ...overrides,
  }
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${adminToken}` }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const fakeProcessor: MediaProcessor = {
  async probe(_assetId, options): Promise<SourceProbe> {
    if (holdProbe) {
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new MediaToolError('canceled'))
          return
        }
        const onAbort = (): void => reject(new MediaToolError('canceled'))
        options.signal?.addEventListener('abort', onAbort, { once: true })
        releaseProbe = () => {
          options.signal?.removeEventListener('abort', onAbort)
          resolve()
        }
      })
      holdProbe = false
    }
    return { durationMs: 60_000, videoCodec: 'h264', audioCodec: 'aac', width: 1280, height: 720 }
  },

  async transcode(assetId, options) {
    const dir = join(store.workDir(assetId), 'hls')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.m3u8'), [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXTINF:6.0,',
      'seg_00000.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'))
    await writeFile(join(dir, 'seg_00000.ts'), Buffer.alloc(64, 1))
    options.onProgress?.(60_000)
  },

  async extractAudio(assetId) {
    await store.ensureWork(assetId)
    await writeFile(join(store.workDir(assetId), 'audio.wav'), Buffer.alloc(32, 2))
  },

  async detectSilences() {
    return [{ startMs: 30_000, endMs: 31_000 }]
  },

  async cutChunk(assetId, index) {
    return join(store.workDir(assetId), 'chunks', `chunk_${index}.wav`)
  },

  async publish(assetId) {
    await store.publishHls(assetId)
  },
}

const fakeAsr: LongFormAsr = {
  async transcribe({ durationMs }) {
    const half = Math.max(1, Math.floor(durationMs / 2))
    return [
      { startMs: 0, endMs: half, text: '趋势反转的初步信号。' },
      { startMs: half, endMs: durationMs, text: '成交量需要同步放大。' },
    ]
  },
}

const FIGURE_CAPTION = '趋势反转结构示意'
const PARAGRAPH = '趋势反转需要成交量同步放大来确认，避免把反弹误判为反转。'

const fakeLlm: LlmClient = {
  async completeJson(request, parse) {
    // 教材提示词里也会出现“知识点”，必须先匹配教材的独有标识。
    if (request.system.includes('Markdown 教材')) {
      return parse({
        markdown: [
          '# 趋势反转',
          '',
          PARAGRAPH.repeat(60),
          '',
          `![${FIGURE_CAPTION}](figure:fg01)`,
          '',
          PARAGRAPH.repeat(5),
        ].join('\n'),
      })
    }
    if (request.system.includes('教学图示')) {
      return parse({
        figures: [{ kind: 'generated', caption: FIGURE_CAPTION, prompt: '纯净的趋势反转结构示意图' }],
      })
    }
    if (request.system.includes('知识点')) {
      return parse({
        knowledgePoints: [
          {
            title: '趋势反转',
            excerpt: '趋势反转的初步信号',
            chapterTitle: '趋势反转',
            confidence: 0.9,
          },
          {
            title: '成交量确认',
            excerpt: '成交量需要同步放大',
            chapterTitle: '趋势反转',
            confidence: 0.1,
          },
        ],
      })
    }
    if (request.system.includes('章节大纲')) {
      return parse({ chapters: [{ title: '趋势反转' }] })
    }
    throw new Error('unexpected prompt')
  },
}

function fakePng(width = 1024, height = 1024): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes[24] = 8
  bytes[25] = 2
  return bytes
}

const fakeImageClient: ImageClient = {
  async generate(): Promise<GeneratedImage> {
    imageCalls += 1
    return { bytes: fakePng(), format: 'png' }
  },
}

/** 测试单价 ¥2.5：两次渲染正好用满单课 ¥10 预算，第三次必须被硬停。 */
let TEST_IMAGE: ResolvedImage

const fakeReindex = async (): Promise<{ embedded: number }> => {
  reindexCalls += 1
  if (reindexFails) throw new Error('embedding unavailable')
  return { embedded: 2 }
}

async function loginAdmin(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/session',
    payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  })
  assert.equal(response.statusCode, 200, response.body)
  return (response.json() as { token: string }).token
}

async function learnerHeaders(): Promise<Record<string, string>> {
  const username = 'pipeline-learner-01'
  const created = await app.inject({
    method: 'POST',
    url: '/v1/admin/users',
    headers: adminHeaders(),
    payload: { username, displayName: '管线学员', role: 'student', password: STUDENT_PASSWORD },
  })
  assert.ok(created.statusCode === 201 || created.statusCode === 409, created.body)

  const start = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/code',
    payload: { clientId: 'dsh-plugin-trend-coach', deviceId: LEARNER_DEVICE_ID },
  })
  assert.equal(start.statusCode, 200, start.body)
  const { deviceCode, userCode } = start.json() as { deviceCode: string; userCode: string }

  const approve = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/approve',
    payload: { userCode, username, password: STUDENT_PASSWORD },
  })
  assert.equal(approve.statusCode, 200, approve.body)

  const poll = await app.inject({
    method: 'POST',
    url: '/v1/auth/device/token',
    payload: { deviceCode },
  })
  const body = poll.json() as { status: string; grant?: { accessToken: string; deviceId: string } }
  assert.equal(body.status, 'authorized', poll.body)
  const grant = body.grant
  assert.ok(grant !== undefined)
  return { authorization: `Bearer ${grant.accessToken}`, 'x-device-id': grant.deviceId }
}

async function createAsset(courseId = COURSE_ID, title = '测试视频'): Promise<AssetBody> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/media-assets',
    headers: adminHeaders(),
    payload: { courseId, title },
  })
  assert.equal(response.statusCode, 201, response.body)
  return (response.json() as { asset: AssetBody }).asset
}

async function uploadSource(assetId: string, body: Buffer, sha?: string): Promise<void> {
  const headers: Record<string, string> = {
    ...adminHeaders(),
    'content-type': 'application/octet-stream',
  }
  if (sha !== undefined) headers['x-file-sha256'] = sha
  const response = await app.inject({
    method: 'PUT',
    url: `/v1/admin/content/media-assets/${assetId}/source`,
    headers,
    payload: body,
  })
  assert.equal(response.statusCode, 200, response.body)
}

async function enqueueIngest(assetId: string): Promise<JobBody> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/media-assets/${assetId}/ingest`,
    headers: adminHeaders(),
    payload: { language: 'zh' },
  })
  assert.equal(response.statusCode, 202, response.body)
  return (response.json() as { job: JobBody }).job
}

async function getJob(jobId: string): Promise<JobBody & { result: { transcriptId: string | null; generationId: string | null } }> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/pipeline/jobs/${jobId}`,
    headers: adminHeaders(),
  })
  assert.equal(response.statusCode, 200, response.body)
  return (response.json() as { job: JobBody & { result: { transcriptId: string | null; generationId: string | null } } }).job
}

async function waitForJob(
  jobId: string,
  predicate: (job: JobBody) => boolean,
  timeoutMs = 10_000,
): Promise<JobBody> {
  const deadline = Date.now() + timeoutMs
  let last: JobBody | null = null
  while (Date.now() < deadline) {
    last = await getJob(jobId)
    if (predicate(last)) return last
    await delay(50)
  }
  assert.fail(`job ${jobId} did not reach expected state: ${JSON.stringify(last)}`)
}

interface FigureCandidateBody {
  candidateId: string
  status: string
  width: number | null
  height: number | null
  bytes: number | null
  sourceSec: number | null
  errorCode: string | null
  previewUrl: string | null
}

interface FigureBody {
  figureId: string
  chapterId: string
  kind: string
  caption: string
  status: string
  selectedCandidateId: string | null
  prompt: string | null
  model: string | null
  seed: number | null
  reviewReasons: string[]
  candidates: FigureCandidateBody[]
}

async function listFigures(courseId = COURSE_ID): Promise<FigureBody[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/figures?courseId=${courseId}`,
    headers: adminHeaders(),
  })
  assert.equal(response.statusCode, 200, response.body)
  return (response.json() as { figures: FigureBody[] }).figures
}

async function waitForFigure(
  predicate: (figure: FigureBody) => boolean,
  timeoutMs = 10_000,
): Promise<FigureBody> {
  const deadline = Date.now() + timeoutMs
  let last: FigureBody[] = []
  while (Date.now() < deadline) {
    last = await listFigures()
    const match = last.find(predicate)
    if (match !== undefined) return match
    await delay(50)
  }
  assert.fail(`figure did not reach expected state: ${JSON.stringify(last)}`)
}

async function illustrateJob(chapterIds?: string[]): Promise<JobBody> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/courses/${COURSE_ID}/illustrate`,
    headers: adminHeaders(),
    ...(chapterIds === undefined ? {} : { payload: { chapterIds } }),
  })
  assert.equal(response.statusCode, 202, response.body)
  return (response.json() as { job: JobBody }).job
}

function armProbe(): void {
  holdProbe = true
  releaseProbe = null
}

function releaseGate(): void {
  holdProbe = false
  const release = releaseProbe
  releaseProbe = null
  release?.()
}

before(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'trend-coach-pipeline-'))
  hlsDir = await mkdtemp(join(tmpdir(), 'trend-coach-hls-'))
  figureDir = await mkdtemp(join(tmpdir(), 'trend-coach-figures-'))

  await runMigrations(pool, { reset: true })
  config = loadConfig(env())
  const models = new ModelConfigService(pool, {
    encryptionKey: config.credentialEncryptionKey,
    asrTimeoutMs: config.asrTimeoutMs,
    llmTuning: config.llmTuning,
  })
  await models.createLlm({
    name: '测试文生图',
    provider: 'ark',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'test-image-model',
    purpose: 'image',
    apiKey: 'test-image-key',
    isDefault: true,
    imagePriceMicros: 2_500_000,
  })
  const resolvedImage = await models.resolveImage()
  assert.ok(resolvedImage !== undefined)
  TEST_IMAGE = resolvedImage
  store = createLocalMediaStore({ storageDir, hlsDir })
  metrics = createMetrics()
  const pipeline = config.pipeline
  assert.ok(pipeline !== undefined)
  const usage = new AiUsageService(pool)
  runtime = await createPipelineRuntime({
    pool,
    config,
    metrics,
    log: { info() {}, warn() {}, error() {} },
    store,
    processor: fakeProcessor,
    asr: fakeAsr,
    llm: fakeLlm,
    image: TEST_IMAGE,
    illustrator: createIllustrationHook({
      pool,
      config: pipeline,
      store,
      figureStore: createFigureStore(figureDir),
      tools: { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
      resolveImage: async () => TEST_IMAGE,
      clientFor: () => fakeImageClient,
      usage,
    }),
    reindex: fakeReindex,
  })
  app = await buildApp({ config, pool, pipeline: runtime, metrics, startPipeline: true })
  await app.ready()
  adminToken = await loginAdmin()

  const course = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/courses',
    headers: adminHeaders(),
    payload: { courseId: COURSE_ID, title: '管线测试课程' },
  })
  assert.equal(course.statusCode, 201, course.body)
})

after(async () => {
  await app.close()
  await pool.end()
  await rm(storageDir, { recursive: true, force: true })
  await rm(hlsDir, { recursive: true, force: true })
  await rm(figureDir, { recursive: true, force: true })
})

test('管线：鉴权、素材登记与上传边界', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/content/media-assets' })
  assert.equal(anonymous.statusCode, 401)

  const badToken = await app.inject({
    method: 'GET',
    url: '/v1/admin/content/media-assets',
    headers: { authorization: 'Bearer not-a-session' },
  })
  assert.equal(badToken.statusCode, 401)

  const missingCourse = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/media-assets',
    headers: adminHeaders(),
    payload: { courseId: 'NOPE-404', title: '不存在' },
  })
  assert.equal(missingCourse.statusCode, 404)

  const invalidCourse = await app.inject({
    method: 'POST',
    url: '/v1/admin/content/media-assets',
    headers: adminHeaders(),
    payload: { courseId: 'bad id', title: '非法' },
  })
  assert.equal(invalidCourse.statusCode, 400)

  const asset = await createAsset()
  assert.equal(asset.courseId, COURSE_ID)
  assert.equal(asset.status, 'awaiting_upload')
  assert.equal(asset.title, '测试视频')
  assert.deepEqual(
    Object.keys(asset).sort(),
    ['assetId', 'courseId', 'createdAt', 'durationMs', 'errorCode', 'sourceSizeBytes', 'status', 'title', 'updatedAt'],
  )
  assert.equal(JSON.stringify(asset).includes('sources/'), false)
  assert.equal(JSON.stringify(asset).includes('hls/'), false)

  const wrongType = await app.inject({
    method: 'PUT',
    url: `/v1/admin/content/media-assets/${asset.assetId}/source`,
    headers: { ...adminHeaders(), 'content-type': 'application/json' },
    payload: { source: 'not-a-file' },
  })
  assert.equal(wrongType.statusCode, 415)

  const tooLarge = await app.inject({
    method: 'PUT',
    url: `/v1/admin/content/media-assets/${asset.assetId}/source`,
    headers: { ...adminHeaders(), 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(8192, 1),
  })
  assert.equal(tooLarge.statusCode, 413)

  const badChecksum = await app.inject({
    method: 'PUT',
    url: `/v1/admin/content/media-assets/${asset.assetId}/source`,
    headers: {
      ...adminHeaders(),
      'content-type': 'application/octet-stream',
      'x-file-sha256': '0'.repeat(64),
    },
    payload: SOURCE,
  })
  assert.equal(badChecksum.statusCode, 400)

  const invalidSha = await app.inject({
    method: 'PUT',
    url: `/v1/admin/content/media-assets/${asset.assetId}/source`,
    headers: {
      ...adminHeaders(),
      'content-type': 'application/octet-stream',
      'x-file-sha256': 'NOT-HEX',
    },
    payload: SOURCE,
  })
  assert.equal(invalidSha.statusCode, 400)

  await uploadSource(asset.assetId, SOURCE, sha256(SOURCE))
  const listed = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/media-assets?courseId=${COURSE_ID}`,
    headers: adminHeaders(),
  })
  assert.equal(listed.statusCode, 200, listed.body)
  const page = listed.json() as { assets: AssetBody[]; total: number; offset: number; limit: number }
  const uploaded = page.assets.find(item => item.assetId === asset.assetId)
  assert.equal(uploaded?.status, 'uploaded')
  assert.equal(uploaded?.sourceSizeBytes, SOURCE.length)

  const transcriptMissing = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/media-assets/${asset.assetId}/transcript`,
    headers: adminHeaders(),
  })
  assert.equal(transcriptMissing.statusCode, 404)

  const unknownJob = await app.inject({
    method: 'GET',
    url: '/v1/admin/content/pipeline/jobs/job_0000000000000000',
    headers: adminHeaders(),
  })
  assert.equal(unknownJob.statusCode, 404)

  const unknownAsset = await app.inject({
    method: 'GET',
    url: '/v1/admin/content/media-assets/asset_0000000000000000/transcript',
    headers: adminHeaders(),
  })
  assert.equal(unknownAsset.statusCode, 404)

  const retitled = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/content/media-assets/${asset.assetId}`,
    headers: adminHeaders(),
    payload: { title: '测试视频（改）' },
  })
  assert.equal(retitled.statusCode, 200, retitled.body)
  assert.equal((retitled.json() as { asset: AssetBody }).asset.title, '测试视频（改）')

  const emptyPatch = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/content/media-assets/${asset.assetId}`,
    headers: adminHeaders(),
    payload: {},
  })
  assert.equal(emptyPatch.statusCode, 400)
})

test('管线：转码转写闭环、重复入队、任务列表与指标', async () => {
  const asset = await createAsset(COURSE_ID, '闭环视频')
  await uploadSource(asset.assetId, SOURCE, sha256(SOURCE))

  armProbe()
  const job = await enqueueIngest(asset.assetId)
  assert.equal(job.kind, 'ingest')
  assert.equal(job.assetId, asset.assetId)
  assert.equal(job.courseId, COURSE_ID)
  assert.equal(job.status, 'queued')
  assert.equal(job.attempts, 0)

  const duplicate = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/media-assets/${asset.assetId}/ingest`,
    headers: adminHeaders(),
    payload: { language: 'zh' },
  })
  assert.equal(duplicate.statusCode, 409)

  await waitForJob(job.jobId, current => current.status === 'running')
  releaseGate()

  const succeeded = await waitForJob(job.jobId, current => current.status === 'succeeded')
  assert.equal(succeeded.progress, 100)
  assert.equal(succeeded.stage, 'done')
  assert.equal(succeeded.errorCode, null)
  assert.equal(succeeded.attempts, 1)
  assert.ok(succeeded.startedAt !== null)
  assert.ok(succeeded.finishedAt !== null)

  const transcriptResponse = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/media-assets/${asset.assetId}/transcript?offset=0&limit=100`,
    headers: adminHeaders(),
  })
  assert.equal(transcriptResponse.statusCode, 200, transcriptResponse.body)
  const transcript = transcriptResponse.json() as {
    transcript: {
      transcriptId: string
      assetId: string
      status: string
      language: string
      durationMs: number | null
      chunkCount: number
      segmentCount: number
      errorCode: string | null
    }
    segments: { idx: number; startMs: number; endMs: number; text: string }[]
    total: number
    offset: number
    limit: number
  }
  assert.equal(transcript.transcript.status, 'ready')
  assert.equal(transcript.transcript.language, 'zh')
  assert.equal(transcript.transcript.durationMs, 60_000)
  assert.equal(transcript.transcript.chunkCount, 1)
  assert.ok(transcript.transcript.segmentCount >= 1)
  assert.equal(transcript.total, transcript.transcript.segmentCount)
  assert.equal(transcript.segments.length, transcript.total)
  let previousEnd = -1
  for (const segment of transcript.segments) {
    assert.ok(segment.startMs >= previousEnd)
    assert.ok(segment.endMs > segment.startMs)
    assert.ok(segment.text.length > 0)
    previousEnd = segment.endMs
  }

  const assetList = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/media-assets?courseId=${COURSE_ID}`,
    headers: adminHeaders(),
  })
  const ready = (assetList.json() as { assets: AssetBody[] }).assets
    .find(item => item.assetId === asset.assetId)
  assert.equal(ready?.status, 'ready')
  assert.equal(ready?.durationMs, 60_000)
  assert.equal(ready?.errorCode, null)

  const detail = await getJob(job.jobId)
  assert.equal(detail.result.transcriptId, transcript.transcript.transcriptId)
  assert.equal(detail.result.generationId, null)

  const jobs = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/pipeline/jobs?assetId=${asset.assetId}&kind=ingest`,
    headers: adminHeaders(),
  })
  assert.equal(jobs.statusCode, 200, jobs.body)
  const jobsBody = jobs.json() as { jobs: JobBody[]; total: number; offset: number; limit: number }
  assert.equal(jobsBody.total, 1)
  assert.equal(jobsBody.jobs[0]?.jobId, job.jobId)

  const badStatus = await app.inject({
    method: 'GET',
    url: '/v1/admin/content/pipeline/jobs?status=nope',
    headers: adminHeaders(),
  })
  assert.equal(badStatus.statusCode, 400)

  const retryFinished = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/pipeline/jobs/${job.jobId}/retry`,
    headers: adminHeaders(),
  })
  assert.equal(retryFinished.statusCode, 409)

  const cancelFinished = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/pipeline/jobs/${job.jobId}/cancel`,
    headers: adminHeaders(),
  })
  assert.equal(cancelFinished.statusCode, 409)

  const metricsResponse = await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  })
  assert.equal(metricsResponse.statusCode, 200)
  assert.match(metricsResponse.body, /trend_coach_pipeline_jobs_total\{kind="ingest",status="succeeded"\} 1/)
  assert.match(metricsResponse.body, /trend_coach_pipeline_queue_depth/)
  assert.match(metricsResponse.body, /trend_coach_pipeline_stage_duration_seconds/)
})

test('管线：运行中取消、失败状态与重试恢复', async () => {
  const asset = await createAsset(COURSE_ID, '取消视频')
  await uploadSource(asset.assetId, SOURCE, sha256(SOURCE))

  armProbe()
  const job = await enqueueIngest(asset.assetId)
  await waitForJob(job.jobId, current => current.status === 'running')

  const canceled = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/pipeline/jobs/${job.jobId}/cancel`,
    headers: adminHeaders(),
  })
  assert.equal(canceled.statusCode, 200, canceled.body)
  const canceledJob = (canceled.json() as { job: JobBody }).job
  assert.ok(canceledJob.status === 'running' || canceledJob.status === 'canceled')

  releaseGate()
  const finished = await waitForJob(job.jobId, current => current.status === 'canceled')
  assert.equal(finished.errorCode, 'job_canceled')

  const failedAsset = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/media-assets?courseId=${COURSE_ID}`,
    headers: adminHeaders(),
  })
  const failed = (failedAsset.json() as { assets: AssetBody[] }).assets
    .find(item => item.assetId === asset.assetId)
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.errorCode, 'job_canceled')

  const retried = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/pipeline/jobs/${job.jobId}/retry`,
    headers: adminHeaders(),
  })
  assert.equal(retried.statusCode, 200, retried.body)
  const requeued = (retried.json() as { job: JobBody }).job
  assert.equal(requeued.status, 'queued')
  assert.equal(requeued.attempts, 0)
  assert.equal(requeued.cancelRequested, false)

  const resumed = await waitForJob(job.jobId, current => current.status === 'succeeded')
  assert.equal(resumed.errorCode, null)
  assert.equal(resumed.attempts, 1)
})

test('管线：归档素材拒绝处理与上传', async () => {
  const asset = await createAsset(COURSE_ID, '归档视频')

  const archived = await app.inject({
    method: 'PATCH',
    url: `/v1/admin/content/media-assets/${asset.assetId}`,
    headers: adminHeaders(),
    payload: { status: 'archived' },
  })
  assert.equal(archived.statusCode, 200, archived.body)
  assert.equal((archived.json() as { asset: AssetBody }).asset.status, 'archived')

  const upload = await app.inject({
    method: 'PUT',
    url: `/v1/admin/content/media-assets/${asset.assetId}/source`,
    headers: { ...adminHeaders(), 'content-type': 'application/octet-stream' },
    payload: SOURCE,
  })
  assert.equal(upload.statusCode, 409)

  const ingest = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/media-assets/${asset.assetId}/ingest`,
    headers: adminHeaders(),
    payload: {},
  })
  assert.equal(ingest.statusCode, 409)
})

test('管线：生成、预览、应用、发布与学员可见性', async () => {
  const asset = await createAsset(COURSE_ID, '生成视频')
  await uploadSource(asset.assetId, SOURCE, sha256(SOURCE))
  const ingest = await enqueueIngest(asset.assetId)
  await waitForJob(ingest.jobId, current => current.status === 'succeeded')

  const missing = await app.inject({
    method: 'GET',
    url: '/v1/admin/content/generations/gen_0000000000000000',
    headers: adminHeaders(),
  })
  assert.equal(missing.statusCode, 404)

  const enqueued = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/media-assets/${asset.assetId}/generations`,
    headers: adminHeaders(),
  })
  assert.equal(enqueued.statusCode, 202, enqueued.body)
  const generationJob = (enqueued.json() as { job: JobBody }).job
  assert.equal(generationJob.kind, 'generate')

  const duplicate = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/media-assets/${asset.assetId}/generations`,
    headers: adminHeaders(),
  })
  assert.equal(duplicate.statusCode, 409)

  const finished = await waitForJob(generationJob.jobId, current => current.status === 'succeeded')
  assert.equal(finished.stage, 'done')
  assert.equal(finished.progress, 100)

  const detail = await getJob(generationJob.jobId)
  const generationId = detail.result.generationId
  assert.ok(generationId !== null)

  const previewResponse = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/generations/${generationId}`,
    headers: adminHeaders(),
  })
  assert.equal(previewResponse.statusCode, 200, previewResponse.body)
  const preview = previewResponse.json() as {
    generation: {
      generationId: string
      status: string
      counts: {
        chapters: number
        knowledgePoints: number
        chapterArticles: number
        figures: number
        segments: number
        needsReview: number
      }
    }
    chapters: { key: string; title: string; position: number; articleLength: number; hasArticle: boolean; figureCount: number }[]
    knowledgePoints: {
      key: string
      chapterKey: string
      title: string
      confidence: number
      needsReview: boolean
      reviewReasons: string[]
    }[]
    figures: { key: string; chapterKey: string; kind: string; caption: string; candidateCount: number; needsReview: boolean }[]
    segments: { key: string; pointKey: string; title: string; startMs: number; endMs: number }[]
  }
  assert.equal(preview.generation.generationId, generationId)
  assert.equal(preview.generation.status, 'draft')
  assert.equal(preview.generation.counts.chapters, 1)
  assert.equal(preview.generation.counts.knowledgePoints, 2)
  assert.equal(preview.generation.counts.chapterArticles, 1)
  assert.equal(preview.generation.counts.figures, 1)
  assert.ok(preview.generation.counts.segments >= 1)
  assert.equal(preview.generation.counts.needsReview, 1)
  assert.deepEqual(preview.chapters.map(chapter => chapter.title), ['趋势反转'])
  assert.equal(preview.chapters[0]?.hasArticle, true)
  assert.ok((preview.chapters[0]?.articleLength ?? 0) >= 1500)
  assert.equal(preview.chapters[0]?.figureCount, 1)
  assert.equal(preview.knowledgePoints.every(point => point.chapterKey === preview.chapters[0]?.key), true)
  const lowConfidence = preview.knowledgePoints.find(point => point.title === '成交量确认')
  assert.equal(lowConfidence?.needsReview, true)
  assert.deepEqual(lowConfidence?.reviewReasons, ['low_confidence'])
  assert.equal(lowConfidence?.confidence, 0.1)
  assert.equal(preview.figures[0]?.kind, 'generated')
  assert.equal(preview.figures[0]?.caption, FIGURE_CAPTION)
  assert.equal(preview.figures[0]?.candidateCount, 2)
  assert.equal(preview.figures[0]?.needsReview, false)
  assert.ok((preview.segments[0]?.endMs ?? 0) > (preview.segments[0]?.startMs ?? 0))
  assert.equal(previewResponse.body.includes('成交量需要同步放大'), false)

  const applyResponse = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/generations/${generationId}/apply`,
    headers: adminHeaders(),
  })
  assert.equal(applyResponse.statusCode, 200, applyResponse.body)
  const applied = applyResponse.json() as {
    generationId: string
    alreadyApplied: boolean
    courseId: string
    chapters: { chapterId: string; key: string }[]
    knowledgePoints: { knowledgePointId: string; key: string }[]
    figures: { figureId: string; key: string }[]
    segments: { segmentId: string; key: string }[]
    chapterArticles: number
    figuresApplied: number
  }
  assert.equal(applied.generationId, generationId)
  assert.equal(applied.alreadyApplied, false)
  assert.equal(applied.courseId, COURSE_ID)
  assert.equal(applied.chapters.length, 1)
  assert.equal(applied.knowledgePoints.length, 2)
  assert.equal(applied.segments.length, preview.generation.counts.segments)
  assert.equal(applied.chapterArticles, 1)
  assert.equal(applied.figuresApplied, 1)
  assert.equal(applied.figures.length, 1)
  const chapterId = applied.chapters[0]?.chapterId
  const figureId = applied.figures[0]?.figureId
  const segmentId = applied.segments[0]?.segmentId
  assert.ok(chapterId !== undefined && figureId !== undefined && segmentId !== undefined)

  const repeatResponse = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/generations/${generationId}/apply`,
    headers: adminHeaders(),
  })
  assert.equal(repeatResponse.statusCode, 200, repeatResponse.body)
  const repeated = repeatResponse.json() as typeof applied
  assert.equal(repeated.alreadyApplied, true)
  assert.deepEqual(repeated.chapters, applied.chapters)
  assert.deepEqual(repeated.knowledgePoints, applied.knowledgePoints)
  assert.deepEqual(repeated.figures, applied.figures)
  assert.deepEqual(repeated.segments, applied.segments)

  const stored = await pool.query<{ kind: string; status: string }>(
    `SELECT 'segment' AS kind, status FROM segments WHERE course_id = $1
     UNION ALL
     SELECT 'chapter_article' AS kind, status FROM chapter_articles WHERE course_id = $1
     UNION ALL
     SELECT 'figure' AS kind, status FROM figures WHERE course_id = $1`,
    [COURSE_ID],
  )
  assert.ok(stored.rows.length >= 3)
  const statusByKind = new Map(stored.rows.map(row => [row.kind, row.status]))
  assert.equal(statusByKind.get('segment'), 'draft')
  assert.equal(statusByKind.get('chapter_article'), 'draft')
  assert.equal(statusByKind.get('figure'), 'planned')

  const storedArticle = await pool.query<{ markdown: string }>(
    'SELECT markdown FROM chapter_articles WHERE course_id = $1 AND chapter_id = $2',
    [COURSE_ID, chapterId],
  )
  assert.match(storedArticle.rows[0]?.markdown ?? '', new RegExp(`figure:${figureId}`))

  const learner = await learnerHeaders()
  const coursesBefore = await app.inject({
    method: 'GET',
    url: '/v1/catalog/courses',
    headers: learner,
  })
  assert.equal(coursesBefore.statusCode, 200, coursesBefore.body)
  const listed = coursesBefore.json() as { courses: { courseId: string }[] }
  assert.equal(listed.courses.some(course => course.courseId === COURSE_ID), false)

  const treeBefore = await app.inject({
    method: 'GET',
    url: `/v1/catalog/courses/${COURSE_ID}`,
    headers: learner,
  })
  assert.equal(treeBefore.statusCode, 404)

  const searchBefore = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: learner,
    payload: { query: '趋势反转', topK: 5 },
  })
  assert.equal(searchBefore.statusCode, 200, searchBefore.body)
  assert.deepEqual((searchBefore.json() as { segments: unknown[] }).segments, [])

  const playbackBefore = await app.inject({
    method: 'POST',
    url: '/v1/playback/sessions',
    headers: learner,
    payload: { segmentId },
  })
  assert.equal(playbackBefore.statusCode, 404)

  // 学员只有设备令牌，没有后台会话，管理端在会话校验处即拒绝。
  const learnerPreview = await app.inject({
    method: 'GET',
    url: `/v1/admin/content/generations/${generationId}`,
    headers: learner,
  })
  assert.equal(learnerPreview.statusCode, 401)

  // 正文引用了未出图的图示：发布闸门先于重建索引。
  const blockedPublish = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/courses/${COURSE_ID}/publish`,
    headers: adminHeaders(),
  })
  assert.equal(blockedPublish.statusCode, 409, blockedPublish.body)
  const blockedBody = blockedPublish.json() as { error: { code: string; figureIds: string[] } }
  assert.equal(blockedBody.error.code, 'figure_unresolved')
  assert.deepEqual(blockedBody.error.figureIds, [figureId])
  assert.equal(reindexCalls, 0)

  const planned = await listFigures()
  assert.equal(planned.length, 1)
  assert.equal(planned[0]?.figureId, figureId)
  assert.equal(planned[0]?.kind, 'generated')
  assert.equal(planned[0]?.caption, FIGURE_CAPTION)
  assert.equal(planned[0]?.status, 'planned')
  assert.equal(planned[0]?.selectedCandidateId, null)
  assert.deepEqual(planned[0]?.candidates, [])

  const emptyTargets = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/courses/${COURSE_ID}/illustrate`,
    headers: adminHeaders(),
    payload: { chapterIds: [] },
  })
  assert.equal(emptyTargets.statusCode, 400)

  const illustrate = await illustrateJob()
  assert.equal(illustrate.kind, 'illustrate')
  assert.equal(illustrate.assetId, null)
  assert.equal(illustrate.courseId, COURSE_ID)
  const illustrated = await waitForJob(illustrate.jobId, current => current.status === 'succeeded')
  assert.equal(illustrated.errorCode, null)
  assert.equal(imageCalls, 2)

  const readyFigure = await waitForFigure(figure => figure.figureId === figureId && figure.status === 'ready')
  assert.equal(readyFigure.selectedCandidateId, null)
  assert.equal(readyFigure.model, TEST_IMAGE.model)
  assert.equal(readyFigure.candidates.length, 2)
  for (const candidate of readyFigure.candidates) {
    assert.equal(candidate.status, 'ready')
    assert.equal(candidate.width, 1024)
    assert.equal(candidate.height, 1024)
    assert.equal(candidate.bytes, fakePng().length)
    assert.equal(candidate.sourceSec, null)
    assert.equal(candidate.errorCode, null)
    assert.equal(candidate.previewUrl, `/v1/admin/content/figure-candidates/${candidate.candidateId}`)
  }
  const firstCandidate = readyFigure.candidates[0]
  assert.ok(firstCandidate !== undefined)

  const previewImage = await app.inject({
    method: 'GET',
    url: firstCandidate.previewUrl ?? '',
    headers: adminHeaders(),
  })
  assert.equal(previewImage.statusCode, 200, previewImage.body)
  assert.match(String(previewImage.headers['content-type']), /^image\/png/)
  assert.equal(previewImage.rawPayload.length, fakePng().length)

  const anonymousPreview = await app.inject({
    method: 'GET',
    url: firstCandidate.previewUrl ?? '',
  })
  assert.equal(anonymousPreview.statusCode, 401)

  const missingCandidate = await app.inject({
    method: 'GET',
    url: '/v1/admin/content/figure-candidates/cand_0000000000000000',
    headers: adminHeaders(),
  })
  assert.equal(missingCandidate.statusCode, 404)

  const selected = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/figures/${figureId}/select`,
    headers: adminHeaders(),
    payload: { candidateId: firstCandidate.candidateId },
  })
  assert.equal(selected.statusCode, 200, selected.body)
  const selectedFigure = (selected.json() as { figure: FigureBody }).figure
  assert.equal(selectedFigure.selectedCandidateId, firstCandidate.candidateId)
  assert.equal(selectedFigure.status, 'ready')

  const badSelection = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/figures/${figureId}/select`,
    headers: adminHeaders(),
    payload: { candidateId: 'cand_0000000000000000' },
  })
  assert.equal(badSelection.statusCode, 404)

  const deleteBlocked = await app.inject({
    method: 'DELETE',
    url: `/v1/admin/content/figures/${figureId}`,
    headers: adminHeaders(),
  })
  assert.equal(deleteBlocked.statusCode, 409, deleteBlocked.body)
  assert.equal(
    (deleteBlocked.json() as { error: { code: string } }).error.code,
    'figure_in_use',
  )

  // 第一次重渲染后单课预算正好用满 ¥10，第二次必须被硬停。
  const regenerated = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/figures/${figureId}/regenerate`,
    headers: adminHeaders(),
  })
  assert.equal(regenerated.statusCode, 202, regenerated.body)
  const regenerating = (regenerated.json() as { figure: FigureBody }).figure
  assert.equal(regenerating.status, 'planned')
  assert.equal(regenerating.selectedCandidateId, null)
  assert.deepEqual(regenerating.candidates, [])

  const refreshed = await waitForFigure(
    figure => figure.figureId === figureId
      && figure.status === 'ready'
      && figure.candidates.length === 2,
  )
  assert.equal(imageCalls, 4)
  assert.equal(refreshed.candidates.every(candidate => candidate.candidateId !== firstCandidate.candidateId), true)
  const finalCandidate = refreshed.candidates[1]
  assert.ok(finalCandidate !== undefined)

  const budgetBlocked = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/figures/${figureId}/regenerate`,
    headers: adminHeaders(),
  })
  assert.equal(budgetBlocked.statusCode, 409, budgetBlocked.body)
  const budgetBody = budgetBlocked.json() as {
    error: { code: string; courseSpentMicros: number; courseLimitMicros: number }
  }
  assert.equal(budgetBody.error.code, 'image_budget_exceeded')
  assert.equal(budgetBody.error.courseSpentMicros, 10_000_000)
  assert.equal(budgetBody.error.courseLimitMicros, 10_000_000)
  assert.equal(imageCalls, 4)

  const finalSelection = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/figures/${figureId}/select`,
    headers: adminHeaders(),
    payload: { candidateId: finalCandidate.candidateId },
  })
  assert.equal(finalSelection.statusCode, 200, finalSelection.body)

  reindexFails = true
  const failedPublish = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/courses/${COURSE_ID}/publish`,
    headers: adminHeaders(),
  })
  assert.equal(failedPublish.statusCode, 503)
  reindexFails = false
  assert.equal(reindexCalls, 1)

  const publishResponse = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/courses/${COURSE_ID}/publish`,
    headers: adminHeaders(),
  })
  assert.equal(publishResponse.statusCode, 200, publishResponse.body)
  const published = publishResponse.json() as {
    courseId: string
    published: true
    indexed: boolean
    embedded: number
    counts: {
      chapters: number
      knowledgePoints: number
      chapterArticles: number
      figures: number
      segments: number
    }
  }
  assert.equal(published.courseId, COURSE_ID)
  assert.equal(published.published, true)
  assert.deepEqual(published.counts, {
    chapters: 1,
    knowledgePoints: 2,
    chapterArticles: 1,
    figures: 1,
    segments: preview.generation.counts.segments,
  })
  assert.equal(published.indexed, true)
  assert.equal(published.embedded, 2)
  assert.equal(reindexCalls, 2)

  const publishAgain = await app.inject({
    method: 'POST',
    url: `/v1/admin/content/courses/${COURSE_ID}/publish`,
    headers: adminHeaders(),
  })
  assert.equal(publishAgain.statusCode, 200, publishAgain.body)
  const republished = publishAgain.json() as typeof published
  assert.deepEqual(republished.counts, {
    chapters: 1,
    knowledgePoints: 2,
    chapterArticles: 1,
    figures: 0,
    segments: preview.generation.counts.segments,
  })
  assert.equal(reindexCalls, 3)

  const treeAfter = await app.inject({
    method: 'GET',
    url: `/v1/catalog/courses/${COURSE_ID}`,
    headers: learner,
  })
  assert.equal(treeAfter.statusCode, 200, treeAfter.body)
  const treeBody = treeAfter.json() as {
    contractVersion: number
    chapters: { chapterId: string; hasArticle: boolean; figureCount: number }[]
  }
  assert.equal(treeBody.contractVersion, 2)
  assert.equal(treeBody.chapters.length, 1)
  assert.equal(treeBody.chapters[0]?.chapterId, chapterId)
  assert.equal(treeBody.chapters[0]?.hasArticle, true)
  assert.equal(treeBody.chapters[0]?.figureCount, 1)

  const chapterResponse = await app.inject({
    method: 'GET',
    url: `/v1/catalog/courses/${COURSE_ID}/chapters/${chapterId}`,
    headers: learner,
  })
  assert.equal(chapterResponse.statusCode, 200, chapterResponse.body)
  const chapterBody = chapterResponse.json() as {
    chapterId: string
    article: { markdown: string; version: number; publishedAt: number } | null
    figures: Record<string, { url: string; width: number; height: number; alt: string; caption?: string }>
    adjacentChapters: unknown[]
  }
  assert.equal(chapterBody.chapterId, chapterId)
  assert.ok(chapterBody.article !== null)
  assert.equal(chapterBody.article.version, 1)
  assert.equal(typeof chapterBody.article.publishedAt, 'number')
  assert.match(chapterBody.article.markdown, new RegExp(`figure:${figureId}`))
  const chapterFigure = chapterBody.figures[figureId]
  assert.ok(chapterFigure !== undefined)
  assert.equal(chapterFigure.width, 1024)
  assert.equal(chapterFigure.height, 1024)
  assert.equal(chapterFigure.alt, FIGURE_CAPTION)
  assert.equal(chapterFigure.caption, FIGURE_CAPTION)

  const signedUrl = new URL(chapterFigure.url)
  assert.equal(signedUrl.pathname, `/media/figures/${figureId}/${finalCandidate.candidateId}.png`)
  assert.match(signedUrl.searchParams.get('expires') ?? '', /^\d+$/)
  assert.ok((signedUrl.searchParams.get('sig') ?? '').length > 0)

  const figureMedia = await app.inject({
    method: 'GET',
    url: `${signedUrl.pathname}${signedUrl.search}`,
  })
  assert.equal(figureMedia.statusCode, 200, figureMedia.body)
  assert.match(String(figureMedia.headers['content-type']), /^image\/png/)
  assert.equal(figureMedia.rawPayload.length, fakePng().length)

  const tampered = await app.inject({
    method: 'GET',
    url: `${signedUrl.pathname}${signedUrl.search.replace(/sig=[^&]+/, 'sig=bad')}`,
  })
  assert.equal(tampered.statusCode, 403)

  const expired = await app.inject({
    method: 'GET',
    url: `${signedUrl.pathname}${signedUrl.search.replace(/expires=[^&]+/, 'expires=1')}`,
  })
  assert.equal(expired.statusCode, 403)

  // 图片签名过期后，客户端靠重拉章节换取新地址；新地址必须立即可用。
  const reSignedChapter = await app.inject({
    method: 'GET',
    url: `/v1/catalog/courses/${COURSE_ID}/chapters/${chapterId}`,
    headers: learner,
  })
  assert.equal(reSignedChapter.statusCode, 200, reSignedChapter.body)
  const reSignedFigure = (reSignedChapter.json() as typeof chapterBody).figures[figureId]
  assert.ok(reSignedFigure !== undefined)
  const reSignedUrl = new URL(reSignedFigure.url)
  assert.equal(reSignedUrl.pathname, signedUrl.pathname)
  assert.ok(Number(reSignedUrl.searchParams.get('expires')) >= Number(signedUrl.searchParams.get('expires')))
  const reSignedMedia = await app.inject({
    method: 'GET',
    url: `${reSignedUrl.pathname}${reSignedUrl.search}`,
  })
  assert.equal(reSignedMedia.statusCode, 200, reSignedMedia.body)
  assert.equal(reSignedMedia.rawPayload.length, fakePng().length)

  const searchAfter = await app.inject({
    method: 'POST',
    url: '/v1/kb/search',
    headers: learner,
    payload: { query: '趋势反转', topK: 5 },
  })
  assert.equal(searchAfter.statusCode, 200, searchAfter.body)
  const found = searchAfter.json() as { segments: { segmentId: string; courseId: string }[] }
  assert.ok(found.segments.length >= 1)
  assert.equal(found.segments.every(segment => segment.courseId === COURSE_ID), true)

  const playbackAfter = await app.inject({
    method: 'POST',
    url: '/v1/playback/sessions',
    headers: learner,
    payload: { segmentId },
  })
  assert.equal(playbackAfter.statusCode, 200, playbackAfter.body)
  assert.match((playbackAfter.json() as { playlistUrl: string }).playlistUrl, /^http:\/\/127\.0\.0\.1:3939\/media\//)
})
