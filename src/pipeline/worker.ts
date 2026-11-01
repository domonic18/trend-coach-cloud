import { randomBytes } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { AsrConfig, PipelineConfig } from '../config.js'
import { AsrError } from '../asr/provider.js'
import type { LongFormAsr } from '../asr/longform.js'
import type { Metrics } from '../metrics.js'
import { planAudioChunks } from './chunks.js'
import { ASR_CHUNK_MAX_SEC, PIPELINE_ERRORS } from './constants.js'
import { JobCanceledError, PipelineFailure } from './failures.js'
import { MediaToolError, SourceProbeError } from './ffmpeg.js'
import { JobQueue, type PipelineJob } from './jobs.js'
import type { MediaProcessor } from './media-processor.js'
import type { MediaStore } from './media-store.js'
import type { SilenceInterval } from './silence.js'
import { groupTranscriptSegments, mergeChunkSentences } from './transcript.js'
import type { JobStage, SourceProbe, TranscriptSentence } from './types.js'

type Language = 'zh' | 'en' | 'auto'

export interface WorkerLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface GenerationHook {
  (
    job: PipelineJob,
    signal: AbortSignal,
    progress: (stage: JobStage, value: number) => Promise<void>,
  ): Promise<void>
}

export interface WorkerDeps {
  pool: Pool
  config: PipelineConfig
  jobs: JobQueue
  store: MediaStore
  processor: MediaProcessor
  asr?: LongFormAsr
  asrConfig?: AsrConfig
  asrLongTimeoutMs: number
  generator?: GenerationHook
  log: WorkerLogger
  metrics?: Metrics
}

interface AssetRow {
  asset_id: string
  course_id: string
  status: string
  duration_ms: string | number | null
  hls_path: string | null
  source_size_bytes: string | number | null
}

interface ChunkRow {
  chunk_id: string
  idx: number
  start_ms: string | number
  end_ms: string | number
  status: 'pending' | 'processing' | 'done' | 'failed'
  sentences: unknown
}

function milliseconds(value: string | number): number {
  return typeof value === 'number' ? value : Number(value)
}

function languageOf(job: PipelineJob): Language {
  const value = job.options.language
  return value === 'zh' || value === 'en' ? value : 'auto'
}

function assertNotCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new JobCanceledError()
}

function parseSentences(value: unknown): TranscriptSentence[] {
  if (!Array.isArray(value)) return []
  const result: TranscriptSentence[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (
      typeof entry.startMs === 'number'
      && typeof entry.endMs === 'number'
      && typeof entry.text === 'string'
      && entry.endMs > entry.startMs
      && entry.text.trim() !== ''
    ) {
      result.push({ startMs: entry.startMs, endMs: entry.endMs, text: entry.text })
    }
  }
  return result
}

function mapMediaError(error: unknown): PipelineFailure {
  if (error instanceof JobCanceledError) throw error
  if (error instanceof MediaToolError) {
    if (error.reason === 'canceled') throw new JobCanceledError()
    return new PipelineFailure(PIPELINE_ERRORS.ffmpegFailed, error.reason !== 'unavailable')
  }
  if (error instanceof SourceProbeError) {
    return new PipelineFailure(PIPELINE_ERRORS.sourceInvalid, false)
  }
  return new PipelineFailure(PIPELINE_ERRORS.internal, true)
}

function mapAsrError(error: unknown): PipelineFailure {
  if (error instanceof JobCanceledError) throw error
  if (error instanceof MediaToolError) return mapMediaError(error)
  if (error instanceof AsrError) {
    if (error.kind === 'unavailable') return new PipelineFailure(PIPELINE_ERRORS.asrUnavailable, true)
    return new PipelineFailure(PIPELINE_ERRORS.transcribeFailed, true)
  }
  return new PipelineFailure(PIPELINE_ERRORS.transcribeFailed, true)
}

export class PipelineWorker {
  private readonly workerId = `worker_${randomBytes(4).toString('hex')}`
  private readonly running = new Set<Promise<void>>()
  private readonly inFlight = new Set<AbortController>()
  private started = false
  private stopping = false
  private ticking = false
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: WorkerDeps) {}

  start(): void {
    if (this.started) return
    this.started = true
    void this.run()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const controller of this.inFlight) controller.abort()
    await Promise.allSettled([...this.running])
  }

  private async run(): Promise<void> {
    await this.tick()
    if (this.stopping) return
    this.timer = setTimeout(() => {
      void this.run()
    }, this.deps.config.pollIntervalMs)
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopping) return
    this.ticking = true
    try {
      await this.deps.jobs.recoverStale(this.deps.config.staleJobMs)
      this.deps.metrics?.pipelineQueueDepth.set(await this.deps.jobs.queueDepth())
      while (this.running.size < this.deps.config.maxConcurrentJobs) {
        const job = await this.deps.jobs.claim(this.workerId)
        if (job === null) break
        const task = this.processJob(job).catch(error => {
          this.deps.log.error({
            err: error,
            jobId: job.jobId,
            kind: job.kind,
          }, 'pipeline job crashed')
        })
        void task.finally(() => this.running.delete(task))
        this.running.add(task)
      }
    } catch (error) {
      this.deps.log.error({ err: error }, 'pipeline worker tick failed')
    } finally {
      this.ticking = false
    }
  }

  private async processJob(job: PipelineJob): Promise<void> {
    const controller = new AbortController()
    this.inFlight.add(controller)
    let stage: JobStage = job.stage
    let stageStarted = Date.now()
    let stageRecorded = false

    const recordStage = (): void => {
      if (stageRecorded) return
      this.deps.metrics?.pipelineStageDuration.observe(
        { kind: job.kind, stage },
        (Date.now() - stageStarted) / 1000,
      )
      stageRecorded = true
    }

    const onProgress = async (next: JobStage, value: number): Promise<void> => {
      // 阶段与进度点是取消的最小检查粒度；快任务不能只靠心跳发现取消。
      if (await this.deps.jobs.isCanceled(job.jobId)) {
        controller.abort()
        throw new JobCanceledError()
      }
      if (next !== stage) {
        recordStage()
        stage = next
        stageStarted = Date.now()
        stageRecorded = false
      }
      await this.deps.jobs.setProgress(job.jobId, this.workerId, next, value)
    }

    const heartbeat = setInterval(() => {
      void this.deps.jobs.heartbeat(job.jobId, this.workerId)
      void this.deps.jobs.isCanceled(job.jobId).then(canceled => {
        if (canceled && !controller.signal.aborted) controller.abort()
      })
    }, this.deps.config.heartbeatMs)
    heartbeat.unref()

    try {
      this.deps.log.info({ jobId: job.jobId, kind: job.kind, attempts: job.attempts }, 'pipeline job started')
      await onProgress(job.stage, job.progress)
      if (job.kind === 'ingest') {
        await this.runIngest(job, controller.signal, onProgress)
      } else {
        if (this.deps.generator === undefined) {
          throw new PipelineFailure(PIPELINE_ERRORS.generationFailed, false)
        }
        await this.deps.generator(job, controller.signal, onProgress)
      }
      recordStage()
      if (await this.deps.jobs.isCanceled(job.jobId)) throw new JobCanceledError()
      await this.deps.jobs.succeed(job.jobId, this.workerId)
      this.deps.metrics?.pipelineJobs.inc({ kind: job.kind, status: 'succeeded' })
      this.deps.log.info({ jobId: job.jobId, kind: job.kind }, 'pipeline job succeeded')
    } catch (error) {
      const canceled = !this.stopping && (error instanceof JobCanceledError
        || (error instanceof MediaToolError && error.reason === 'canceled')
        || controller.signal.aborted)
      if (canceled) {
        await this.deps.jobs.markCanceled(job.jobId, this.workerId)
        if (job.kind === 'ingest') await this.markAssetFailed(job.assetId, PIPELINE_ERRORS.canceled)
        this.deps.metrics?.pipelineJobs.inc({ kind: job.kind, status: 'canceled' })
        this.deps.log.info({ jobId: job.jobId, kind: job.kind }, 'pipeline job canceled')
      } else {
        const failure = error instanceof PipelineFailure
          ? error
          : new PipelineFailure(PIPELINE_ERRORS.internal, true)
        const outcome = await this.deps.jobs.fail(job.jobId, this.workerId, failure.code, failure.retryable)
        if (outcome === 'failed' && job.kind === 'ingest') {
          await this.markAssetFailed(job.assetId, failure.code)
        }
        this.deps.metrics?.pipelineJobs.inc({
          kind: job.kind,
          status: outcome === 'retry' ? 'queued' : 'failed',
        })
        // 不记录 stderr、源路径与 provider 响应体，只留稳定错误码。
        this.deps.log.warn({
          jobId: job.jobId,
          kind: job.kind,
          stage,
          errorCode: failure.code,
          retry: outcome === 'retry',
        }, 'pipeline job failed')
      }
    } finally {
      recordStage()
      clearInterval(heartbeat)
      this.inFlight.delete(controller)
    }
  }

  private async runIngest(
    job: PipelineJob,
    signal: AbortSignal,
    onProgress: (stage: JobStage, value: number) => Promise<void>,
  ): Promise<void> {
    const { config, pool, processor, store } = this.deps
    const asset = await this.fetchAsset(job.assetId)
    if (asset === null) throw new PipelineFailure(PIPELINE_ERRORS.sourceInvalid, false)
    if (asset.source_size_bytes === null) throw new PipelineFailure(PIPELINE_ERRORS.sourceMissing, false)

    assertNotCanceled(signal)
    let durationMs = asset.duration_ms === null ? null : milliseconds(asset.duration_ms)
    if (durationMs === null) {
      await onProgress('probe', 2)
      let probe: SourceProbe
      try {
        probe = await processor.probe(job.assetId, { timeoutMs: config.audioTimeoutMs, signal })
      } catch (error) {
        throw mapMediaError(error)
      }
      durationMs = probe.durationMs
      await pool.query(
        `UPDATE media_assets SET duration_ms = $2, status = 'processing', updated_at = now()
         WHERE asset_id = $1`,
        [job.assetId, durationMs],
      )
    }
    await onProgress('probe', 5)
    assertNotCanceled(signal)

    await pool.query(
      `UPDATE media_assets SET status = 'processing', updated_at = now() WHERE asset_id = $1`,
      [job.assetId],
    )

    const hlsReady = asset.hls_path !== null
      && await access(join(store.hlsOutputDir(job.assetId), 'index.m3u8')).then(() => true, () => false)
    if (!hlsReady) {
      await onProgress('transcode', 5)
      let lastUpdate = 0
      try {
        await processor.transcode(job.assetId, {
          timeoutMs: config.ffmpegTimeoutMs,
          signal,
          onProgress: outMs => {
            const now = Date.now()
            if (now - lastUpdate < 1000) return
            lastUpdate = now
            const ratio = durationMs === null || durationMs <= 0 ? 0 : Math.min(1, outMs / durationMs)
            void onProgress('transcode', 5 + Math.round(ratio * 50)).catch(() => undefined)
          },
        })
        assertNotCanceled(signal)
        await processor.publish(job.assetId)
      } catch (error) {
        if (error instanceof PipelineFailure || error instanceof JobCanceledError) throw error
        throw mapMediaError(error)
      }
      await pool.query(
        `UPDATE media_assets SET hls_path = $2, updated_at = now() WHERE asset_id = $1`,
        [job.assetId, store.hlsRelPath(job.assetId)],
      )
    }

    await onProgress('transcribe', 60)
    assertNotCanceled(signal)

    if (this.deps.asr === undefined || this.deps.asrConfig === undefined || durationMs === null) {
      throw new PipelineFailure(PIPELINE_ERRORS.asrUnavailable, false)
    }
    const asr = this.deps.asr
    const language = languageOf(job)

    const audioPath = join(store.workDir(job.assetId), 'audio.wav')
    const audioReady = await access(audioPath).then(() => true, () => false)
    if (!audioReady) {
      try {
        await processor.extractAudio(job.assetId, { timeoutMs: config.audioTimeoutMs, signal })
      } catch (error) {
        throw mapMediaError(error)
      }
    }

    let silences: SilenceInterval[]
    try {
      silences = await processor.detectSilences(job.assetId, {
        timeoutMs: config.audioTimeoutMs,
        signal,
      })
    } catch (error) {
      throw mapMediaError(error)
    }
    const chunks = planAudioChunks({ durationMs, maxSec: ASR_CHUNK_MAX_SEC, silences })
    if (chunks.length === 0) throw new PipelineFailure(PIPELINE_ERRORS.transcribeFailed, true)

    const transcriptId = await this.ensureTranscript(job, durationMs, language)
    await this.ensureChunkRows(transcriptId, chunks)

    const rows = await this.loadChunks(transcriptId)
    const total = Math.max(1, rows.length)
    let completed = rows.filter(row => row.status === 'done').length
    const pending = rows.filter(row => row.status !== 'done')
    let cursor = 0
    let failure: unknown = null

    const runners = Array.from({ length: Math.min(config.asrConcurrency, pending.length) }, async () => {
      while (failure === null) {
        const index = cursor
        cursor += 1
        const row = pending[index]
        if (row === undefined) return
        try {
          assertNotCanceled(signal)
          await this.transcribeChunk(row, job, language, signal)
          completed += 1
          await onProgress('transcribe', 60 + Math.round((completed / total) * 35))
        } catch (error) {
          failure ??= error
          return
        }
      }
    })
    await Promise.all(runners)
    if (failure !== null) throw failure
    assertNotCanceled(signal)

    await onProgress('finalize', 95)
    // 转写只更新数据库；重读一次才能拿到新写入的 sentences 与 done 状态。
    await this.finalizeTranscript(job, transcriptId, await this.loadChunks(transcriptId))
    await store.removeWork(job.assetId).catch(() => undefined)
    await onProgress('finalize', 100)
  }

  private async transcribeChunk(
    row: ChunkRow,
    job: PipelineJob,
    language: Language,
    signal: AbortSignal,
  ): Promise<void> {
    const { config, pool, processor } = this.deps
    const asr = this.deps.asr
    if (asr === undefined) throw new PipelineFailure(PIPELINE_ERRORS.asrUnavailable, false)
    const startMs = milliseconds(row.start_ms)
    const endMs = milliseconds(row.end_ms)

    await pool.query(
      `UPDATE transcript_chunks SET status = 'processing', attempt = attempt + 1, updated_at = now()
       WHERE chunk_id = $1`,
      [row.chunk_id],
    )
    try {
      const wavPath = await processor.cutChunk(
        job.assetId,
        row.idx,
        { startMs, endMs },
        { timeoutMs: config.audioTimeoutMs, signal },
      )
      const sentences = await asr.transcribe({
        wavPath,
        durationMs: endMs - startMs,
        language,
        timeoutMs: this.deps.asrLongTimeoutMs,
        signal,
      })
      await pool.query(
        `UPDATE transcript_chunks
         SET status = 'done', sentences = $2::jsonb, error_code = NULL, updated_at = now()
         WHERE chunk_id = $1`,
        [row.chunk_id, JSON.stringify(sentences)],
      )
    } catch (error) {
      const failure = mapAsrError(error)
      await pool.query(
        `UPDATE transcript_chunks SET status = 'failed', error_code = $2, updated_at = now()
         WHERE chunk_id = $1`,
        [row.chunk_id, failure.code],
      ).catch(() => undefined)
      throw failure
    }
  }

  private async ensureTranscript(
    job: PipelineJob,
    durationMs: number,
    language: Language,
  ): Promise<string> {
    const transcriptId = `tr_${randomBytes(8).toString('hex')}`
    const { rows } = await this.deps.pool.query<{ transcript_id: string }>(
      `INSERT INTO media_transcripts (transcript_id, asset_id, job_id, status, language, model, duration_ms)
       VALUES ($1, $2, $3, 'processing', $4, $5, $6)
       ON CONFLICT (asset_id) DO UPDATE
       SET job_id = EXCLUDED.job_id,
           status = 'processing',
           language = EXCLUDED.language,
           model = EXCLUDED.model,
           duration_ms = EXCLUDED.duration_ms,
           error_code = NULL,
           updated_at = now()
       RETURNING transcript_id`,
      [transcriptId, job.assetId, job.jobId, language, this.deps.asrConfig?.model ?? 'unknown', durationMs],
    )
    const row = rows[0]
    if (row === undefined) throw new PipelineFailure(PIPELINE_ERRORS.internal, true)
    return row.transcript_id
  }

  private async ensureChunkRows(
    transcriptId: string,
    chunks: { index: number; startMs: number; endMs: number }[],
  ): Promise<void> {
    for (const chunk of chunks) {
      await this.deps.pool.query(
        `INSERT INTO transcript_chunks (chunk_id, transcript_id, idx, start_ms, end_ms)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (transcript_id, idx) DO NOTHING`,
        [`chunk_${randomBytes(8).toString('hex')}`, transcriptId, chunk.index, chunk.startMs, chunk.endMs],
      ).catch(error => {
        // 唯一 (transcript_id, start_ms, end_ms) 冲突说明计划未变，视为已存在。
        if ((error as { code?: string }).code !== '23505') throw error
      })
    }
  }

  private async loadChunks(transcriptId: string): Promise<ChunkRow[]> {
    const { rows } = await this.deps.pool.query<ChunkRow>(
      `SELECT chunk_id, idx, start_ms, end_ms, status, sentences
       FROM transcript_chunks WHERE transcript_id = $1 ORDER BY idx`,
      [transcriptId],
    )
    return rows
  }

  private async finalizeTranscript(
    job: PipelineJob,
    transcriptId: string,
    rows: ChunkRow[],
  ): Promise<void> {
    const done = rows
      .filter(row => row.status === 'done')
      .sort((left, right) => left.idx - right.idx)
    const sentences = mergeChunkSentences(done.map(row => ({
      startMs: milliseconds(row.start_ms),
      endMs: milliseconds(row.end_ms),
      sentences: parseSentences(row.sentences),
    })))
    const segments = groupTranscriptSegments(sentences, this.deps.config.transcriptSegmentMaxSec)
    if (segments.length === 0) throw new PipelineFailure(PIPELINE_ERRORS.transcribeFailed, true)

    const durationMs = await this.assetDuration(job.assetId)
    const client = await this.deps.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM transcript_segments WHERE transcript_id = $1', [transcriptId])
      for (const [index, segment] of segments.entries()) {
        await client.query(
          `INSERT INTO transcript_segments (transcript_id, idx, start_ms, end_ms, text)
           VALUES ($1, $2, $3, $4, $5)`,
          [transcriptId, index, segment.startMs, segment.endMs, segment.text],
        )
      }
      await client.query(
        `UPDATE media_transcripts
         SET status = 'ready', chunk_count = $2, segment_count = $3, duration_ms = $4,
             error_code = NULL, updated_at = now()
         WHERE transcript_id = $1`,
        [transcriptId, rows.length, segments.length, durationMs],
      )
      await client.query(
        `UPDATE media_assets
         SET status = 'ready', error_code = NULL, duration_ms = $2, updated_at = now()
         WHERE asset_id = $1`,
        [job.assetId, durationMs],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async assetDuration(assetId: string): Promise<number | null> {
    const { rows } = await this.deps.pool.query<{ duration_ms: string | number | null }>(
      'SELECT duration_ms FROM media_assets WHERE asset_id = $1',
      [assetId],
    )
    const value = rows[0]?.duration_ms
    return value === null || value === undefined ? null : milliseconds(value)
  }

  private async fetchAsset(assetId: string): Promise<AssetRow | null> {
    const { rows } = await this.deps.pool.query<AssetRow>(
      `SELECT asset_id, course_id, status, duration_ms, hls_path, source_size_bytes
       FROM media_assets WHERE asset_id = $1`,
      [assetId],
    )
    return rows[0] ?? null
  }

  private async markAssetFailed(assetId: string, errorCode: string): Promise<void> {
    await this.deps.pool.query(
      `UPDATE media_assets SET status = 'failed', error_code = $2, updated_at = now()
       WHERE asset_id = $1 AND status <> 'archived'`,
      [assetId, errorCode],
    ).catch(() => undefined)
  }
}
