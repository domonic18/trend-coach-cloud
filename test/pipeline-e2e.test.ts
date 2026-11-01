import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import type { LongFormAsr } from '../src/asr/longform.js'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { createMetrics, type Metrics } from '../src/metrics.js'
import { runMigrations } from '../src/migrate.js'
import { MediaToolError } from '../src/pipeline/ffmpeg.js'
import type { MediaProcessor } from '../src/pipeline/media-processor.js'
import { createLocalMediaStore, type MediaStore } from '../src/pipeline/media-store.js'
import { createPipelineRuntime, type PipelineRuntime } from '../src/pipeline/runtime.js'
import type { SourceProbe } from '../src/pipeline/types.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://trend_coach:trend_coach@127.0.0.1:5432/trend_coach_test'
const ADMIN_USERNAME = 'pipeline-admin-01'
const ADMIN_PASSWORD = 'pipeline-password-123'
const METRICS_TOKEN = 'test-metrics-token-1234'
const COURSE_ID = 'T-PIPE-01'
const SOURCE = Buffer.from('fake-video-source-payload')

const pool = createPool(DATABASE_URL)
let storageDir = ''
let hlsDir = ''
let app: FastifyInstance
let runtime: PipelineRuntime
let store: MediaStore
let metrics: Metrics
let adminToken = ''
let holdProbe = false
let releaseProbe: (() => void) | null = null

interface JobBody {
  jobId: string
  assetId: string
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

async function loginAdmin(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/session',
    payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  })
  assert.equal(response.statusCode, 200, response.body)
  return (response.json() as { token: string }).token
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

  await runMigrations(pool, { reset: true })
  const config = loadConfig(env())
  store = createLocalMediaStore({ storageDir, hlsDir })
  metrics = createMetrics()
  runtime = await createPipelineRuntime({
    pool,
    config,
    metrics,
    log: { info() {}, warn() {}, error() {} },
    store,
    processor: fakeProcessor,
    asr: fakeAsr,
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
