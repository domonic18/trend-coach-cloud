import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import type { JobKind, JobStage, JobStatus } from './types.js'

export class ActiveJobError extends Error {
  constructor() {
    super('an active job already exists for this asset')
    this.name = 'ActiveJobError'
  }
}

export interface PipelineJob {
  jobId: string
  assetId: string | null
  courseId: string
  kind: JobKind
  status: JobStatus
  stage: JobStage
  progress: number
  attempts: number
  maxAttempts: number
  runAfter: number
  cancelRequested: boolean
  errorCode: string | null
  options: Record<string, unknown>
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

interface JobRow {
  job_id: string
  asset_id: string | null
  course_id: string
  kind: JobKind
  status: JobStatus
  stage: JobStage
  progress: number
  attempts: number
  max_attempts: number
  run_after: Date
  cancel_requested: boolean
  error_code: string | null
  options: Record<string, unknown>
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

const COLUMNS = `job_id, asset_id, course_id, kind, status, stage, progress, attempts,
  max_attempts, run_after, cancel_requested, error_code, options, created_at, started_at, finished_at`

const BACKOFF_MS = [15_000, 60_000, 300_000]

function mapJob(row: JobRow): PipelineJob {
  return {
    jobId: row.job_id,
    assetId: row.asset_id,
    courseId: row.course_id,
    kind: row.kind,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after.getTime(),
    cancelRequested: row.cancel_requested,
    errorCode: row.error_code,
    options: row.options,
    createdAt: row.created_at.getTime(),
    startedAt: row.started_at?.getTime() ?? null,
    finishedAt: row.finished_at?.getTime() ?? null,
  }
}

function backoffMs(attempts: number): number {
  const base = BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)] ?? 300_000
  return base + Math.floor(Math.random() * 5_000)
}

export class JobQueue {
  constructor(
    private readonly pool: Pool,
    private readonly maxAttempts: number,
  ) {}

  async create(input: {
    assetId: string | null
    courseId: string
    kind: JobKind
    options?: Record<string, unknown>
  }): Promise<PipelineJob> {
    const jobId = `job_${randomBytes(8).toString('hex')}`
    try {
      const { rows } = await this.pool.query<JobRow>(
        `INSERT INTO pipeline_jobs (job_id, asset_id, course_id, kind, max_attempts, options)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING ${COLUMNS}`,
        [jobId, input.assetId, input.courseId, input.kind, this.maxAttempts, JSON.stringify(input.options ?? {})],
      )
      const row = rows[0]
      if (row === undefined) throw new Error('job insert returned no row')
      return mapJob(row)
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ActiveJobError()
      throw error
    }
  }

  /** 单条 UPDATE + SKIP LOCKED 认领，避免两个 worker 抢到同一任务。 */
  async claim(workerId: string): Promise<PipelineJob | null> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE pipeline_jobs
       SET status = 'running',
           stage = CASE
             WHEN kind = 'ingest' THEN 'probe'
             WHEN kind = 'illustrate' THEN 'figure_plan'
             ELSE 'structure'
           END,
           progress = 0,
           attempts = attempts + 1,
           locked_at = now(),
           locked_by = $1,
           heartbeat_at = now(),
           started_at = COALESCE(started_at, now()),
           updated_at = now()
       WHERE job_id = (
         SELECT job_id FROM pipeline_jobs
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY run_after, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${COLUMNS}`,
      [workerId],
    )
    const row = rows[0]
    return row === undefined ? null : mapJob(row)
  }

  async heartbeat(jobId: string, workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE pipeline_jobs SET heartbeat_at = now(), updated_at = now()
       WHERE job_id = $1 AND locked_by = $2 AND status = 'running'`,
      [jobId, workerId],
    )
  }

  async setProgress(jobId: string, workerId: string, stage: JobStage, progress: number): Promise<void> {
    await this.pool.query(
      `UPDATE pipeline_jobs SET stage = $3, progress = $4, updated_at = now()
       WHERE job_id = $1 AND locked_by = $2 AND status = 'running'`,
      [jobId, workerId, stage, Math.min(100, Math.max(0, Math.round(progress)))],
    )
  }

  async succeed(jobId: string, workerId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE pipeline_jobs
       SET status = 'succeeded', stage = 'done', progress = 100, error_code = NULL,
           finished_at = now(), locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
       WHERE job_id = $1 AND locked_by = $2 AND status = 'running'`,
      [jobId, workerId],
    )
    return (rowCount ?? 0) > 0
  }

  async fail(jobId: string, workerId: string, errorCode: string, retryable: boolean): Promise<'retry' | 'failed'> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ attempts: number; max_attempts: number; status: JobStatus }>(
        `SELECT attempts, max_attempts, status FROM pipeline_jobs
         WHERE job_id = $1 AND locked_by = $2 FOR UPDATE`,
        [jobId, workerId],
      )
      const row = rows[0]
      if (row === undefined || row.status !== 'running') {
        await client.query('ROLLBACK')
        return 'failed'
      }
      const retry = retryable && row.attempts < row.max_attempts
      if (retry) {
        await client.query(
          `UPDATE pipeline_jobs
           SET status = 'queued', stage = 'queued', progress = 0, error_code = $3,
               run_after = now() + ($4::int * interval '1 millisecond'),
               locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
           WHERE job_id = $1 AND locked_by = $2`,
          [jobId, workerId, errorCode, backoffMs(row.attempts)],
        )
      } else {
        await client.query(
          `UPDATE pipeline_jobs
           SET status = 'failed', error_code = $3, finished_at = now(),
               locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
           WHERE job_id = $1 AND locked_by = $2`,
          [jobId, workerId, errorCode],
        )
      }
      await client.query('COMMIT')
      return retry ? 'retry' : 'failed'
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async markCanceled(jobId: string, workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE pipeline_jobs
       SET status = 'canceled', error_code = 'job_canceled', finished_at = now(),
           locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
       WHERE job_id = $1 AND locked_by = $2 AND status = 'running'`,
      [jobId, workerId],
    )
  }

  async cancel(jobId: string): Promise<'canceled' | 'requested' | 'not_found' | 'invalid'> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ status: JobStatus }>(
        'SELECT status FROM pipeline_jobs WHERE job_id = $1 FOR UPDATE',
        [jobId],
      )
      const row = rows[0]
      if (row === undefined) {
        await client.query('ROLLBACK')
        return 'not_found'
      }
      if (row.status === 'queued') {
        await client.query(
          `UPDATE pipeline_jobs
           SET status = 'canceled', error_code = 'job_canceled', finished_at = now(), updated_at = now()
           WHERE job_id = $1`,
          [jobId],
        )
        await client.query('COMMIT')
        return 'canceled'
      }
      if (row.status === 'running') {
        await client.query(
          'UPDATE pipeline_jobs SET cancel_requested = true, updated_at = now() WHERE job_id = $1',
          [jobId],
        )
        await client.query('COMMIT')
        return 'requested'
      }
      await client.query('ROLLBACK')
      return 'invalid'
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async isCanceled(jobId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ cancel_requested: boolean; status: JobStatus }>(
      'SELECT cancel_requested, status FROM pipeline_jobs WHERE job_id = $1',
      [jobId],
    )
    const row = rows[0]
    return row === undefined || row.cancel_requested || row.status === 'canceled' || row.status === 'failed'
  }

  async retry(jobId: string): Promise<PipelineJob | null> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE pipeline_jobs
       SET status = 'queued', stage = 'queued', progress = 0, attempts = 0,
           cancel_requested = false, error_code = NULL, run_after = now(),
           locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, finished_at = NULL, updated_at = now()
       WHERE job_id = $1 AND status IN ('failed', 'canceled')
       RETURNING ${COLUMNS}`,
      [jobId],
    )
    const row = rows[0]
    return row === undefined ? null : mapJob(row)
  }

  /** 崩溃恢复：心跳超时的 running 任务回队列；超过重试上限直接失败。 */
  async recoverStale(staleMs: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE pipeline_jobs
       SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
           stage = CASE WHEN attempts < max_attempts THEN 'queued' ELSE stage END,
           run_after = CASE WHEN attempts < max_attempts THEN now() ELSE run_after END,
           error_code = CASE WHEN attempts < max_attempts THEN error_code ELSE 'job_stale' END,
           finished_at = CASE WHEN attempts < max_attempts THEN finished_at ELSE now() END,
           locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
       WHERE status = 'running'
         AND (heartbeat_at IS NULL OR heartbeat_at < now() - ($1::int * interval '1 millisecond'))`,
      [staleMs],
    )
    return rowCount ?? 0
  }

  async get(jobId: string): Promise<PipelineJob | null> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT ${COLUMNS} FROM pipeline_jobs WHERE job_id = $1`,
      [jobId],
    )
    const row = rows[0]
    return row === undefined ? null : mapJob(row)
  }

  async list(filters: {
    status?: JobStatus
    kind?: JobKind
    courseId?: string
    assetId?: string
    offset: number
    limit: number
  }): Promise<{ jobs: PipelineJob[]; total: number }> {
    const conditions: string[] = []
    const values: unknown[] = []
    const add = (condition: (index: number) => string, value: unknown): void => {
      values.push(value)
      conditions.push(condition(values.length))
    }
    if (filters.status !== undefined) add(index => `status = $${index}`, filters.status)
    if (filters.kind !== undefined) add(index => `kind = $${index}`, filters.kind)
    if (filters.courseId !== undefined) add(index => `course_id = $${index}`, filters.courseId)
    if (filters.assetId !== undefined) add(index => `asset_id = $${index}`, filters.assetId)
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`

    const { rows: countRows } = await this.pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM pipeline_jobs ${where}`,
      values,
    )
    const { rows } = await this.pool.query<JobRow>(
      `SELECT ${COLUMNS} FROM pipeline_jobs ${where}
       ORDER BY created_at DESC, job_id DESC
       OFFSET $${values.length + 1} LIMIT $${values.length + 2}`,
      [...values, filters.offset, filters.limit],
    )
    return { jobs: rows.map(mapJob), total: countRows[0]?.total ?? 0 }
  }

  async queueDepth(): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pipeline_jobs WHERE status = 'queued'`,
    )
    return rows[0]?.count ?? 0
  }
}
