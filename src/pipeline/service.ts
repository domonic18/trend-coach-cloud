import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import type { PipelineConfig } from '../config.js'
import { parseContentId } from '../content/service.js'
import { badRequest, conflict, HttpError, notFound, serviceUnavailable } from '../errors.js'
import { codePointLength, stringField } from '../http/validation.js'
import { chapterIdFor, draftSegmentIdFor, knowledgePointIdFor } from './ids.js'
import { ActiveJobError, type JobQueue, type PipelineJob } from './jobs.js'
import { SourceChecksumError, SourceTooLargeError, type MediaStore } from './media-store.js'
import {
  ASSET_STATUSES,
  JOB_KINDS,
  JOB_STATUSES,
  type AssetStatus,
  type GenerationPayload,
  type GenerationStatus,
  type JobKind,
  type JobStatus,
} from './types.js'

const ID = /^[A-Za-z0-9._-]{1,64}$/
const JOB_ID = /^job_[0-9a-f]{16}$/
const GENERATION_ID = /^gen_[0-9a-f]{16}$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_SECONDS = 86_400
const LANGUAGES = ['zh', 'en', 'auto'] as const
export type Language = (typeof LANGUAGES)[number]

export interface PipelineServiceOptions {
  /** 每次入队时查询后台配置，管理员保存后即刻生效。 */
  llmAvailable: () => Promise<boolean>
  reindex?: (courseId: string) => Promise<{ embedded: number }>
  /** 未配置 embedding 时发布仍可用，只是不建向量索引。 */
  embeddingAvailable?: () => Promise<boolean>
}

export interface AssetDto {
  assetId: string
  courseId: string
  title: string | null
  status: AssetStatus
  durationMs: number | null
  sourceSizeBytes: number | null
  errorCode: string | null
  createdAt: number
  updatedAt: number
}

export interface JobDto {
  jobId: string
  assetId: string
  courseId: string
  kind: JobKind
  status: JobStatus
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

export interface JobDetail extends JobDto {
  result: {
    transcriptId: string | null
    generationId: string | null
  }
}

export interface TranscriptPage {
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

export interface GenerationSummary {
  generationId: string
  assetId: string
  courseId: string
  status: GenerationStatus
  promptVersion: string
  model: string
  chapters: number
  knowledgePoints: number
  segments: number
  needsReview: number
  createdAt: number
  updatedAt: number
  appliedAt: number | null
}

export interface GenerationPreview {
  generation: GenerationSummary
  chapters: { key: string; title: string; position: number }[]
  knowledgePoints: {
    key: string
    chapterKey: string
    title: string
    position: number
    confidence: number
    needsReview: boolean
    reviewReasons: string[]
    hasArticle: boolean
  }[]
  segments: { key: string; pointKey: string; title: string; startMs: number; endMs: number }[]
}

export interface AppliedContent {
  chapters: Record<string, string>
  knowledgePoints: Record<string, string>
  segments: Record<string, string>
}

export interface ApplyResult {
  generation: GenerationSummary
  applied: AppliedContent
  alreadyApplied: boolean
}

export interface PublishResult {
  courseId: string
  status: 'published'
  articlesPublished: number
  segmentsPublished: number
  indexed: boolean
  embedded: number
}

export interface AssetFilters {
  courseId?: string
  status?: AssetStatus
  offset: number
  limit: number
}

export interface JobFilters {
  status?: JobStatus
  kind?: JobKind
  courseId?: string
  assetId?: string
  offset: number
  limit: number
}

export interface PipelineApi {
  listAssets(filters: AssetFilters): Promise<{ assets: AssetDto[]; total: number; offset: number; limit: number }>
  createAsset(input: { courseId: string; title: string }): Promise<AssetDto>
  patchAsset(assetId: string, input: { title?: string; status?: 'archived' }): Promise<AssetDto>
  uploadSource(
    assetId: string,
    source: AsyncIterable<Buffer>,
    expectedSha256?: string,
  ): Promise<AssetDto>
  enqueueIngest(assetId: string, language: Language): Promise<JobDto>
  getTranscript(assetId: string, page: { offset: number; limit: number }): Promise<TranscriptPage>
  enqueueGeneration(assetId: string): Promise<JobDto>
  getGeneration(generationId: string): Promise<GenerationPreview>
  applyGeneration(generationId: string): Promise<ApplyResult>
  discardGeneration(generationId: string): Promise<GenerationSummary>
  publishCourse(courseId: string): Promise<PublishResult>
  listJobs(filters: JobFilters): Promise<{ jobs: JobDto[]; total: number; offset: number; limit: number }>
  getJob(jobId: string): Promise<JobDetail>
  retryJob(jobId: string): Promise<JobDto>
  cancelJob(jobId: string): Promise<JobDto>
}

interface AssetRow {
  asset_id: string
  course_id: string
  title: string | null
  status: AssetStatus
  duration_ms: string | number | null
  source_size_bytes: string | number | null
  error_code: string | null
  created_at: Date
  updated_at: Date
}

interface TranscriptRow {
  transcript_id: string
  asset_id: string
  status: string
  language: string
  duration_ms: string | number | null
  chunk_count: number
  segment_count: number
  error_code: string | null
}

interface GenerationRow {
  generation_id: string
  asset_id: string
  course_id: string
  status: GenerationStatus
  prompt_version: string
  model: string
  chapters: number
  knowledge_points: number
  segments: number
  needs_review: number
  payload: unknown
  applied_content: unknown
  created_at: Date
  updated_at: Date
  applied_at: Date | null
}

const GENERATION_COLUMNS = `generation_id, asset_id, course_id, status, prompt_version, model,
  chapters, knowledge_points, segments, needs_review, payload, applied_content,
  created_at, updated_at, applied_at`

function milliseconds(value: string | number | null): number | null {
  if (value === null) return null
  return typeof value === 'number' ? value : Number(value)
}

function toAsset(row: AssetRow): AssetDto {
  return {
    assetId: row.asset_id,
    courseId: row.course_id,
    title: row.title,
    status: row.status,
    durationMs: milliseconds(row.duration_ms),
    sourceSizeBytes: milliseconds(row.source_size_bytes),
    errorCode: row.error_code,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  }
}

export function toJob(job: PipelineJob): JobDto {
  return {
    jobId: job.jobId,
    assetId: job.assetId,
    courseId: job.courseId,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    cancelRequested: job.cancelRequested,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

export function parseAssetId(raw: string): string {
  return stringField({ assetId: raw }, 'assetId', { max: 64, pattern: ID })
}

export function parseJobId(raw: string): string {
  return stringField({ jobId: raw }, 'jobId', { max: 20, pattern: JOB_ID })
}

export function parseGenerationId(raw: string): string {
  return stringField({ generationId: raw }, 'generationId', { max: 20, pattern: GENERATION_ID })
}

export function toGeneration(row: GenerationRow): GenerationSummary {
  return {
    generationId: row.generation_id,
    assetId: row.asset_id,
    courseId: row.course_id,
    status: row.status,
    promptVersion: row.prompt_version,
    model: row.model,
    chapters: row.chapters,
    knowledgePoints: row.knowledge_points,
    segments: row.segments,
    needsReview: row.needs_review,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    appliedAt: row.applied_at?.getTime() ?? null,
  }
}

function readPayload(value: unknown): GenerationPayload {
  if (typeof value !== 'object' || value === null) {
    throw new HttpError(500, 'generation payload invalid')
  }
  const root = value as Record<string, unknown>
  if (!Array.isArray(root.chapters) || !Array.isArray(root.knowledgePoints) || !Array.isArray(root.segments)) {
    throw new HttpError(500, 'generation payload invalid')
  }
  return value as GenerationPayload
}

function readApplied(value: unknown): AppliedContent {
  if (typeof value !== 'object' || value === null) {
    throw new HttpError(500, 'generation applied content invalid')
  }
  const root = value as Record<string, unknown>
  const chapters = root.chapters
  const knowledgePoints = root.knowledgePoints
  const segments = root.segments
  if (
    typeof chapters !== 'object' || chapters === null
    || typeof knowledgePoints !== 'object' || knowledgePoints === null
    || typeof segments !== 'object' || segments === null
  ) {
    throw new HttpError(500, 'generation applied content invalid')
  }
  return {
    chapters: chapters as Record<string, string>,
    knowledgePoints: knowledgePoints as Record<string, string>,
    segments: segments as Record<string, string>,
  }
}

export function parseAssetStatus(value: unknown): AssetStatus {
  if (typeof value !== 'string' || !(ASSET_STATUSES as readonly string[]).includes(value)) {
    throw badRequest(`status must be ${ASSET_STATUSES.join('/')}`)
  }
  return value as AssetStatus
}

export function parseJobStatus(value: unknown): JobStatus {
  if (typeof value !== 'string' || !(JOB_STATUSES as readonly string[]).includes(value)) {
    throw badRequest(`status must be ${JOB_STATUSES.join('/')}`)
  }
  return value as JobStatus
}

export function parseJobKind(value: unknown): JobKind {
  if (typeof value !== 'string' || !(JOB_KINDS as readonly string[]).includes(value)) {
    throw badRequest(`kind must be ${JOB_KINDS.join('/')}`)
  }
  return value as JobKind
}

export function parseLanguage(value: unknown): Language {
  if (value === undefined) return 'auto'
  if (typeof value !== 'string' || !(LANGUAGES as readonly string[]).includes(value)) {
    throw badRequest(`language must be ${LANGUAGES.join('/')}`)
  }
  return value as Language
}

export function parseSha256Header(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (!SHA256.test(value)) throw badRequest('x-file-sha256 must be 64 lowercase hex characters')
  return value
}

export class PipelineService implements PipelineApi {
  constructor(
    private readonly pool: Pool,
    private readonly config: PipelineConfig,
    private readonly jobs: JobQueue,
    private readonly store: MediaStore,
    private readonly options: PipelineServiceOptions = { llmAvailable: async () => false },
  ) {}

  async listAssets(filters: AssetFilters): Promise<{
    assets: AssetDto[]
    total: number
    offset: number
    limit: number
  }> {
    const conditions: string[] = []
    const values: unknown[] = []
    const add = (condition: (index: number) => string, value: unknown): void => {
      values.push(value)
      conditions.push(condition(values.length))
    }
    if (filters.courseId !== undefined) add(index => `course_id = $${index}`, filters.courseId)
    if (filters.status !== undefined) add(index => `status = $${index}`, filters.status)
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`

    const { rows: countRows } = await this.pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM media_assets ${where}`,
      values,
    )
    const { rows } = await this.pool.query<AssetRow>(
      `SELECT asset_id, course_id, title, status, duration_ms, source_size_bytes, error_code,
              created_at, updated_at
       FROM media_assets ${where}
       ORDER BY created_at DESC, asset_id DESC
       OFFSET $${values.length + 1} LIMIT $${values.length + 2}`,
      [...values, filters.offset, filters.limit],
    )
    return {
      assets: rows.map(toAsset),
      total: countRows[0]?.total ?? 0,
      offset: filters.offset,
      limit: filters.limit,
    }
  }

  async createAsset(input: { courseId: string; title: string }): Promise<AssetDto> {
    const { rows: courseRows } = await this.pool.query<{ status: string }>(
      'SELECT status FROM courses WHERE course_id = $1',
      [input.courseId],
    )
    const course = courseRows[0]
    if (course === undefined) throw notFound('course not found')
    if (course.status !== 'draft') throw conflict('course must be draft')

    const assetId = `asset_${randomBytes(8).toString('hex')}`
    const { rows } = await this.pool.query<AssetRow>(
      `INSERT INTO media_assets (asset_id, course_id, hls_path, encryption, title, status)
       VALUES ($1, $2, NULL, 'none', $3, 'awaiting_upload')
       RETURNING asset_id, course_id, title, status, duration_ms, source_size_bytes, error_code,
                 created_at, updated_at`,
      [assetId, input.courseId, input.title],
    )
    const row = rows[0]
    if (row === undefined) throw new HttpError(500, 'asset create failed')
    return toAsset(row)
  }

  async patchAsset(assetId: string, input: { title?: string; status?: 'archived' }): Promise<AssetDto> {
    if (input.title === undefined && input.status === undefined) {
      throw badRequest('at least one of title, status is required')
    }
    const { rows } = await this.pool.query<AssetRow>(
      `UPDATE media_assets
       SET title = COALESCE($2, title), status = COALESCE($3, status), updated_at = now()
       WHERE asset_id = $1
       RETURNING asset_id, course_id, title, status, duration_ms, source_size_bytes, error_code,
                 created_at, updated_at`,
      [assetId, input.title ?? null, input.status ?? null],
    )
    const row = rows[0]
    if (row === undefined) throw notFound('media asset not found')
    return toAsset(row)
  }

  async uploadSource(
    assetId: string,
    source: AsyncIterable<Buffer>,
    expectedSha256?: string,
  ): Promise<AssetDto> {
    const asset = await this.requireAsset(assetId)
    if (asset.status !== 'awaiting_upload' && asset.status !== 'uploaded' && asset.status !== 'failed') {
      throw conflict('asset is not accepting uploads')
    }

    let written
    try {
      written = await this.store.writeSource(assetId, source, {
        limitBytes: this.config.maxUploadBytes,
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      })
    } catch (error) {
      if (error instanceof SourceTooLargeError) throw new HttpError(413, 'source exceeds upload limit')
      if (error instanceof SourceChecksumError) throw badRequest('source checksum mismatch')
      throw error
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // 换源后旧转写与生成草稿不再可信，级联清理后再重新处理。
      await client.query('DELETE FROM media_transcripts WHERE asset_id = $1', [assetId])
      const { rows } = await client.query<AssetRow>(
        `UPDATE media_assets
         SET source_rel_path = $2, source_size_bytes = $3, source_sha256 = $4,
             hls_path = NULL, duration_ms = NULL, error_code = NULL,
             status = 'uploaded', updated_at = now()
         WHERE asset_id = $1
         RETURNING asset_id, course_id, title, status, duration_ms, source_size_bytes, error_code,
                   created_at, updated_at`,
        [assetId, written.relPath, written.sizeBytes, written.sha256],
      )
      await client.query('COMMIT')
      const row = rows[0]
      if (row === undefined) throw new HttpError(500, 'asset update failed')
      return toAsset(row)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async enqueueIngest(assetId: string, language: Language): Promise<JobDto> {
    const asset = await this.requireAsset(assetId)
    if (asset.status === 'archived') throw conflict('asset is archived')
    if (asset.source_size_bytes === null) throw conflict('source is missing')
    if (asset.status === 'processing') throw conflict('asset is already processing')

    let job: PipelineJob
    try {
      job = await this.jobs.create({
        assetId,
        courseId: asset.course_id,
        kind: 'ingest',
        options: { language },
      })
    } catch (error) {
      if (error instanceof ActiveJobError) throw conflict('job already active')
      throw error
    }
    await this.pool.query(
      `UPDATE media_assets SET status = 'processing', error_code = NULL, updated_at = now()
       WHERE asset_id = $1`,
      [assetId],
    )
    return toJob(job)
  }

  async getTranscript(
    assetId: string,
    page: { offset: number; limit: number },
  ): Promise<TranscriptPage> {
    const { rows } = await this.pool.query<TranscriptRow>(
      `SELECT transcript_id, asset_id, status, language, duration_ms, chunk_count, segment_count, error_code
       FROM media_transcripts WHERE asset_id = $1`,
      [assetId],
    )
    const row = rows[0]
    if (row === undefined) throw notFound('transcript not found')

    const { rows: segmentRows } = await this.pool.query<{
      idx: number
      start_ms: string | number
      end_ms: string | number
      text: string
    }>(
      `SELECT idx, start_ms, end_ms, text FROM transcript_segments
       WHERE transcript_id = $1
       ORDER BY idx
       OFFSET $2 LIMIT $3`,
      [row.transcript_id, page.offset, page.limit],
    )
    const segments = segmentRows.map(segment => ({
      idx: segment.idx,
      startMs: Number(segment.start_ms),
      endMs: Number(segment.end_ms),
      text: segment.text,
    }))
    for (const segment of segments) {
      if (codePointLength(segment.text) > 4000) throw new HttpError(500, 'stored transcript invalid')
    }
    return {
      transcript: {
        transcriptId: row.transcript_id,
        assetId: row.asset_id,
        status: row.status,
        language: row.language,
        durationMs: milliseconds(row.duration_ms),
        chunkCount: row.chunk_count,
        segmentCount: row.segment_count,
        errorCode: row.error_code,
      },
      segments,
      total: row.segment_count,
      offset: page.offset,
      limit: page.limit,
    }
  }

  async enqueueGeneration(assetId: string): Promise<JobDto> {
    const asset = await this.requireAsset(assetId)
    if (asset.status === 'archived') throw conflict('asset is archived')
    if (asset.status !== 'ready') throw conflict('asset must be ready')

    const { rows: transcriptRows } = await this.pool.query<{ status: string }>(
      'SELECT status FROM media_transcripts WHERE asset_id = $1',
      [assetId],
    )
    if (transcriptRows[0]?.status !== 'ready') throw conflict('transcript must be ready')

    const { rows: courseRows } = await this.pool.query<{ status: string }>(
      'SELECT status FROM courses WHERE course_id = $1',
      [asset.course_id],
    )
    const course = courseRows[0]
    if (course === undefined) throw notFound('course not found')
    if (course.status !== 'draft') throw conflict('course must be draft')

    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM content_generations WHERE asset_id = $1 AND status = 'draft'`,
      [assetId],
    )
    if ((rowCount ?? 0) > 0) throw conflict('draft generation already exists')
    if (!(await this.options.llmAvailable())) throw serviceUnavailable('content llm unavailable')

    let job: PipelineJob
    try {
      job = await this.jobs.create({ assetId, courseId: asset.course_id, kind: 'generate' })
    } catch (error) {
      if (error instanceof ActiveJobError) throw conflict('job already active')
      throw error
    }
    return toJob(job)
  }

  async getGeneration(generationId: string): Promise<GenerationPreview> {
    const row = await this.requireGeneration(generationId)
    const payload = readPayload(row.payload)
    return {
      generation: toGeneration(row),
      chapters: payload.chapters.map(chapter => ({
        key: chapter.key,
        title: chapter.title,
        position: chapter.position,
      })),
      knowledgePoints: payload.knowledgePoints.map(point => ({
        key: point.key,
        chapterKey: point.chapterKey,
        title: point.title,
        position: point.position,
        confidence: point.confidence,
        needsReview: point.needsReview,
        reviewReasons: point.reviewReasons,
        hasArticle: point.articleMarkdown !== null,
      })),
      segments: payload.segments.map(segment => ({
        key: segment.key,
        pointKey: segment.pointKey,
        title: segment.title,
        startMs: segment.startMs,
        endMs: segment.endMs,
      })),
    }
  }

  async applyGeneration(generationId: string): Promise<ApplyResult> {
    const row = await this.requireGeneration(generationId)
    if (row.status === 'applied') {
      return {
        generation: toGeneration(row),
        applied: readApplied(row.applied_content),
        alreadyApplied: true,
      }
    }
    if (row.status !== 'draft') throw conflict('generation is not a draft')
    const payload = readPayload(row.payload)

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: lockedRows } = await client.query<{ status: GenerationStatus }>(
        'SELECT status FROM content_generations WHERE generation_id = $1 FOR UPDATE',
        [generationId],
      )
      const locked = lockedRows[0]
      if (locked === undefined) throw notFound('generation not found')
      if (locked.status === 'applied') {
        await client.query('COMMIT')
        const appliedRow = await this.requireGeneration(generationId)
        return {
          generation: toGeneration(appliedRow),
          applied: readApplied(appliedRow.applied_content),
          alreadyApplied: true,
        }
      }
      if (locked.status !== 'draft') throw conflict('generation is not a draft')

      const { rows: courseRows } = await client.query<{ status: string }>(
        'SELECT status FROM courses WHERE course_id = $1 FOR UPDATE',
        [row.course_id],
      )
      const course = courseRows[0]
      if (course === undefined) throw notFound('course not found')
      if (course.status !== 'draft') throw conflict('course must be draft')

      const { rows: countRows } = await client.query<{
        chapters: number
        points: number
        segments: number
      }>(
        `SELECT
           (SELECT count(*)::int FROM chapters WHERE course_id = $1) AS chapters,
           (SELECT count(*)::int FROM knowledge_points WHERE course_id = $1) AS points,
           (SELECT count(*)::int FROM segments WHERE course_id = $1) AS segments`,
        [row.course_id],
      )
      const counts = countRows[0]
      if ((counts?.chapters ?? 0) > 0 || (counts?.points ?? 0) > 0 || (counts?.segments ?? 0) > 0) {
        throw conflict('course already has content')
      }

      const chapterIds = new Map<string, string>()
      for (const chapter of payload.chapters) {
        const chapterId = chapterIdFor(generationId, chapter.key)
        await client.query(
          `INSERT INTO chapters (course_id, chapter_id, title, position)
           VALUES ($1, $2, $3, $4)`,
          [row.course_id, chapterId, chapter.title, chapter.position],
        )
        chapterIds.set(chapter.key, chapterId)
      }

      const pointIds = new Map<string, string>()
      const pointChapters = new Map<string, string>()
      const positions = new Map<string, number>()
      for (const point of payload.knowledgePoints) {
        const chapterId = chapterIds.get(point.chapterKey)
        if (chapterId === undefined) throw new HttpError(500, 'generation payload invalid')
        const knowledgePointId = knowledgePointIdFor(generationId, point.key)
        const position = positions.get(chapterId) ?? 0
        positions.set(chapterId, position + 1)
        await client.query(
          `INSERT INTO knowledge_points (knowledge_point_id, course_id, chapter_id, title, position)
           VALUES ($1, $2, $3, $4, $5)`,
          [knowledgePointId, row.course_id, chapterId, point.title, position],
        )
        pointIds.set(point.key, knowledgePointId)
        pointChapters.set(point.key, chapterId)
        if (point.articleMarkdown !== null) {
          await client.query(
            `INSERT INTO articles (knowledge_point_id, markdown, version, status, published_at, updated_at)
             VALUES ($1, $2, 1, 'draft', NULL, now())`,
            [knowledgePointId, point.articleMarkdown],
          )
        }
      }

      const segmentIds = new Map<string, string>()
      for (const segment of payload.segments) {
        const knowledgePointId = pointIds.get(segment.pointKey)
        const chapterId = pointChapters.get(segment.pointKey)
        if (knowledgePointId === undefined || chapterId === undefined) {
          throw new HttpError(500, 'generation payload invalid')
        }
        if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.endMs <= segment.startMs) {
          throw new HttpError(500, 'generation payload invalid')
        }
        const startSec = Math.min(MAX_SECONDS - 1, Math.max(0, Math.floor(segment.startMs / 1000)))
        const endSec = Math.min(MAX_SECONDS, Math.max(startSec + 1, Math.ceil(segment.endMs / 1000)))
        const segmentId = draftSegmentIdFor(generationId, segment.key)
        await client.query(
          `INSERT INTO segments
             (segment_id, course_id, chapter_id, knowledge_point_id, title, start_sec, end_sec, text, status, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', NULL)`,
          [
            segmentId,
            row.course_id,
            chapterId,
            knowledgePointId,
            segment.title,
            startSec,
            endSec,
            segment.text,
          ],
        )
        segmentIds.set(segment.key, segmentId)
      }

      const applied: AppliedContent = {
        chapters: Object.fromEntries(chapterIds),
        knowledgePoints: Object.fromEntries(pointIds),
        segments: Object.fromEntries(segmentIds),
      }
      await client.query(
        `UPDATE content_generations
         SET status = 'applied', applied_content = $2::jsonb, applied_at = now(), updated_at = now()
         WHERE generation_id = $1`,
        [generationId, JSON.stringify(applied)],
      )
      await client.query('COMMIT')

      const updated = await this.requireGeneration(generationId)
      return { generation: toGeneration(updated), applied, alreadyApplied: false }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async discardGeneration(generationId: string): Promise<GenerationSummary> {
    const { rows } = await this.pool.query<GenerationRow>(
      `UPDATE content_generations
       SET status = 'discarded', updated_at = now()
       WHERE generation_id = $1 AND status = 'draft'
       RETURNING ${GENERATION_COLUMNS}`,
      [generationId],
    )
    const row = rows[0]
    if (row !== undefined) return toGeneration(row)
    await this.requireGeneration(generationId)
    throw conflict('generation is not a draft')
  }

  async publishCourse(rawCourseId: string): Promise<PublishResult> {
    const courseId = parseContentId(rawCourseId, 'courseId')
    const { rows: courseRows } = await this.pool.query<{ status: string }>(
      'SELECT status FROM courses WHERE course_id = $1',
      [courseId],
    )
    const course = courseRows[0]
    if (course === undefined) throw notFound('course not found')
    if (course.status === 'archived') throw conflict('course is archived')

    const { rows: countRows } = await this.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM segments WHERE course_id = $1',
      [courseId],
    )
    if ((countRows[0]?.count ?? 0) < 1) throw conflict('course has no segments')

    const reindex = this.options.reindex
    const embeddingReady = reindex !== undefined
      && (this.options.embeddingAvailable === undefined || await this.options.embeddingAvailable())
    let embedded = 0
    if (reindex !== undefined && embeddingReady) {
      try {
        embedded = (await reindex(courseId)).embedded
      } catch {
        throw serviceUnavailable('embedding unavailable')
      }
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const articles = await client.query(
        `UPDATE articles a
         SET status = 'published', published_at = now(), updated_at = now()
         FROM knowledge_points kp
         WHERE a.knowledge_point_id = kp.knowledge_point_id
           AND kp.course_id = $1
           AND a.status = 'draft'`,
        [courseId],
      )
      const segments = await client.query(
        `UPDATE segments
         SET status = 'published', updated_at = now()
         WHERE course_id = $1 AND status = 'draft'`,
        [courseId],
      )
      await client.query(
        `UPDATE courses SET status = 'published' WHERE course_id = $1`,
        [courseId],
      )
      await client.query('COMMIT')
      return {
        courseId,
        status: 'published',
        articlesPublished: articles.rowCount ?? 0,
        segmentsPublished: segments.rowCount ?? 0,
        indexed: embeddingReady,
        embedded,
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listJobs(filters: JobFilters): Promise<{
    jobs: JobDto[]
    total: number
    offset: number
    limit: number
  }> {
    const result = await this.jobs.list(filters)
    return {
      jobs: result.jobs.map(toJob),
      total: result.total,
      offset: filters.offset,
      limit: filters.limit,
    }
  }

  async getJob(jobId: string): Promise<JobDetail> {
    const job = await this.jobs.get(jobId)
    if (job === null) throw notFound('job not found')

    const { rows: transcriptRows } = await this.pool.query<{ transcript_id: string }>(
      'SELECT transcript_id FROM media_transcripts WHERE asset_id = $1',
      [job.assetId],
    )
    const { rows: generationRows } = await this.pool.query<{ generation_id: string }>(
      `SELECT generation_id FROM content_generations WHERE job_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [jobId],
    )
    return {
      ...toJob(job),
      result: {
        transcriptId: transcriptRows[0]?.transcript_id ?? null,
        generationId: generationRows[0]?.generation_id ?? null,
      },
    }
  }

  async retryJob(jobId: string): Promise<JobDto> {
    const current = await this.jobs.get(jobId)
    if (current === null) throw notFound('job not found')
    if (current.status !== 'failed' && current.status !== 'canceled') {
      throw conflict('only failed or canceled jobs can be retried')
    }
    const job = await this.jobs.retry(jobId)
    if (job === null) throw conflict('job cannot be retried')
    if (job.kind === 'ingest') {
      await this.pool.query(
        `UPDATE media_assets SET status = 'processing', error_code = NULL, updated_at = now()
         WHERE asset_id = $1 AND status <> 'archived'`,
        [job.assetId],
      )
    }
    return toJob(job)
  }

  async cancelJob(jobId: string): Promise<JobDto> {
    const outcome = await this.jobs.cancel(jobId)
    if (outcome === 'not_found') throw notFound('job not found')
    if (outcome === 'invalid') throw conflict('job is already finished')
    const job = await this.jobs.get(jobId)
    if (job === null) throw notFound('job not found')
    if (outcome === 'canceled' && job.kind === 'ingest') {
      await this.pool.query(
        `UPDATE media_assets SET status = 'failed', error_code = 'job_canceled', updated_at = now()
         WHERE asset_id = $1 AND status <> 'archived'`,
        [job.assetId],
      )
    }
    return toJob(job)
  }

  private async requireAsset(assetId: string): Promise<AssetRow> {
    const { rows } = await this.pool.query<AssetRow>(
      `SELECT asset_id, course_id, title, status, duration_ms, source_size_bytes, error_code,
              created_at, updated_at
       FROM media_assets WHERE asset_id = $1`,
      [assetId],
    )
    const row = rows[0]
    if (row === undefined) throw notFound('media asset not found')
    return row
  }

  private async requireGeneration(generationId: string): Promise<GenerationRow> {
    const { rows } = await this.pool.query<GenerationRow>(
      `SELECT ${GENERATION_COLUMNS} FROM content_generations WHERE generation_id = $1`,
      [generationId],
    )
    const row = rows[0]
    if (row === undefined) throw notFound('generation not found')
    return row
  }
}
