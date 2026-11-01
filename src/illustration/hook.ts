import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Pool } from 'pg'
import type { AiUsageService } from '../ai/usage.js'
import type { PipelineConfig } from '../config.js'
import type { ResolvedImage } from '../model-config/service.js'
import { PIPELINE_ERRORS } from '../pipeline/constants.js'
import { JobCanceledError, PipelineFailure } from '../pipeline/failures.js'
import { extractFrame, type FfmpegToolPaths } from '../pipeline/ffmpeg.js'
import { candidateIdFor } from '../pipeline/ids.js'
import type { PipelineJob } from '../pipeline/jobs.js'
import type { MediaStore } from '../pipeline/media-store.js'
import type { JobStage } from '../pipeline/types.js'
import type { IllustrationHook, WorkerLogger } from '../pipeline/worker.js'
import { createArkImageClient, ImageProviderError, type ImageClient, type GeneratedImage } from './ark.js'
import { canSpend, readImageBudget, type ImageBudget } from './budget.js'
import { parseImageSize } from './image-size.js'
import type { FigureStore } from './store.js'

const CANDIDATES_PER_FIGURE = 2
const FIGURE_RETRIES = 1
const KEYFRAME_OFFSET_SEC = 2
const MIN_IMAGE_EDGE = 800
const RENDER_FAILED = 'render_failed'
const FRAME_FAILED = 'frame_extract_failed'
const REVIEW_RENDER_FAILED = 'figure_render_failed'

interface FigureRow {
  figure_id: string
  course_id: string
  chapter_id: string
  asset_id: string | null
  kind: 'keyframe' | 'generated'
  caption: string
  prompt: string | null
  source_sec: number | null
  status: string
}

export interface IllustrationDeps {
  pool: Pool
  config: PipelineConfig
  store: MediaStore
  figureStore: FigureStore
  tools: FfmpegToolPaths
  resolveImage: () => Promise<ResolvedImage | undefined>
  /** 测试注入：替换真实文生图调用。 */
  clientFor?: (resolved: ResolvedImage) => ImageClient
  usage?: AiUsageService
  log?: WorkerLogger
}

interface RenderedCandidate {
  candidateId: string
  relPath: string
  width: number
  height: number
  bytes: number
  sha256: string
  sourceSec: number | null
}

function chapterFilter(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const ids = value.filter((item): item is string => typeof item === 'string' && item !== '')
  return ids.length === 0 ? null : ids
}

async function selectFigures(
  pool: Pool,
  courseId: string,
  chapterIds: string[] | null,
): Promise<FigureRow[]> {
  const { rows } = await pool.query<FigureRow>(
    `SELECT figure_id, course_id, chapter_id, asset_id, kind, caption, prompt, source_sec, status
     FROM figures
     WHERE course_id = $1
       AND status IN ('planned', 'failed')
       AND ($2::text[] IS NULL OR chapter_id = ANY($2::text[]))
     ORDER BY chapter_id, created_at, figure_id`,
    [courseId, chapterIds],
  )
  return rows
}

async function resetFigure(pool: Pool, figureId: string, status: string): Promise<void> {
  await pool.query(
    `UPDATE figures SET status = $2, updated_at = now() WHERE figure_id = $1`,
    [figureId, status],
  )
}

async function insertCandidate(
  pool: Pool,
  figureId: string,
  candidate: RenderedCandidate,
): Promise<void> {
  await pool.query(
    `INSERT INTO figure_candidates
       (candidate_id, figure_id, rel_path, width, height, bytes, sha256, source_sec, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready')`,
    [
      candidate.candidateId,
      figureId,
      candidate.relPath,
      candidate.width,
      candidate.height,
      candidate.bytes,
      candidate.sha256,
      candidate.sourceSec,
    ],
  )
}

function usable(image: GeneratedImage): { width: number; height: number } | undefined {
  const size = parseImageSize(image.bytes)
  if (size === undefined) return undefined
  if (Math.min(size.width, size.height) < MIN_IMAGE_EDGE) return undefined
  return { width: size.width, height: size.height }
}

/** 单图渲染：失败只影响自身，2 候选共享 1 次重试。 */
async function renderFigure(
  deps: IllustrationDeps,
  figure: FigureRow,
  resolved: ResolvedImage,
  budget: ImageBudget,
  signal: AbortSignal,
): Promise<void> {
  const client = deps.clientFor?.(resolved) ?? createArkImageClient(resolved, deps.config.imageTimeoutMs)
  await resetFigure(deps.pool, figure.figure_id, 'rendering')
  await deps.pool.query('DELETE FROM figure_candidates WHERE figure_id = $1', [figure.figure_id])

  const rendered: RenderedCandidate[] = []
  let retries = FIGURE_RETRIES
  let budgetBlocked = false
  try {
    for (let index = 0; index < CANDIDATES_PER_FIGURE && !budgetBlocked; index += 1) {
      if (signal.aborted) throw new JobCanceledError()
      const candidateId = candidateIdFor()
      if (figure.kind === 'keyframe') {
        const extracted = await renderKeyframe(deps, figure, candidateId, index, signal)
        if (extracted !== undefined) rendered.push(extracted)
        continue
      }
      if (figure.prompt === null) continue
      while (true) {
        if (!canSpend(budget, resolved.priceMicros)) {
          budgetBlocked = true
          break
        }
        const started = Date.now()
        try {
          const image = await client.generate(figure.prompt, { signal })
          const size = usable(image)
          if (size === undefined) throw new ImageProviderError('invalid')
          const stored = await deps.figureStore.write(figure.figure_id, candidateId, image.format, image.bytes)
          rendered.push({
            candidateId,
            ...stored,
            width: size.width,
            height: size.height,
            sourceSec: null,
          })
          budget.courseSpentMicros += resolved.priceMicros
          budget.orgSpentMicros += resolved.priceMicros
          await deps.usage?.recordStandalone({
            taskKey: 'image.figure',
            configId: resolved.configId,
            provider: resolved.provider,
            model: resolved.model,
            status: 'success',
            latencyMs: Date.now() - started,
            images: 1,
            costMicros: resolved.priceMicros,
            courseId: figure.course_id,
          })
          break
        } catch (error) {
          if (error instanceof JobCanceledError || signal.aborted) throw new JobCanceledError()
          await deps.usage?.recordStandalone({
            taskKey: 'image.figure',
            configId: resolved.configId,
            provider: resolved.provider,
            model: resolved.model,
            status: 'error',
            errorCode: RENDER_FAILED,
            latencyMs: Date.now() - started,
            images: 0,
            costMicros: 0,
            courseId: figure.course_id,
          })
          if (retries <= 0) break
          retries -= 1
        }
      }
    }

    for (const candidate of rendered) await insertCandidate(deps.pool, figure.figure_id, candidate)
    if (rendered.length === 0) {
      await deps.pool.query(
        `UPDATE figures
         SET status = 'failed',
             model = CASE WHEN kind = 'generated' THEN $2 ELSE model END,
             review_reasons = CASE
               WHEN review_reasons ? $3 THEN review_reasons
               ELSE review_reasons || to_jsonb($3::text)
             END,
             updated_at = now()
         WHERE figure_id = $1`,
        [figure.figure_id, resolved.model, REVIEW_RENDER_FAILED],
      )
      return
    }
    await deps.pool.query(
      `UPDATE figures
       SET status = 'ready',
           model = CASE WHEN kind = 'generated' THEN $2 ELSE model END,
           updated_at = now()
       WHERE figure_id = $1`,
      [figure.figure_id, resolved.model],
    )
  } catch (error) {
    if (signal.aborted || error instanceof JobCanceledError) {
      await resetFigure(deps.pool, figure.figure_id, 'planned')
      throw new JobCanceledError()
    }
    deps.log?.warn({ figureId: figure.figure_id, kind: figure.kind }, 'figure render failed')
    await resetFigure(deps.pool, figure.figure_id, 'failed')
  }
}

async function renderKeyframe(
  deps: IllustrationDeps,
  figure: FigureRow,
  candidateId: string,
  index: number,
  signal: AbortSignal,
): Promise<RenderedCandidate | undefined> {
  if (figure.asset_id === null || figure.source_sec === null) return undefined
  const sourceSec = figure.source_sec + index * KEYFRAME_OFFSET_SEC
  const relPath = `${figure.figure_id}/${candidateId}.jpg`
  const target = deps.figureStore.pathOf(relPath)
  try {
    await mkdir(dirname(target), { recursive: true })
    await extractFrame(deps.tools, deps.store.sourcePath(figure.asset_id), target, {
      atSec: sourceSec,
      timeoutMs: deps.config.ffmpegTimeoutMs,
      signal,
    })
    const bytes = await readFile(target)
    const size = parseImageSize(bytes)
    if (size === undefined || Math.min(size.width, size.height) < MIN_IMAGE_EDGE) return undefined
    return {
      candidateId,
      relPath,
      width: size.width,
      height: size.height,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceSec,
    }
  } catch (error) {
    if (signal.aborted || error instanceof JobCanceledError) throw new JobCanceledError()
    return undefined
  }
}

export function createIllustrationHook(deps: IllustrationDeps): IllustrationHook {
  return async (job: PipelineJob, signal: AbortSignal, progress: (stage: JobStage, value: number) => Promise<void>) => {
    const resolved = await deps.resolveImage()
    if (resolved === undefined) {
      throw new PipelineFailure(PIPELINE_ERRORS.imageUnavailable, false)
    }
    await progress('figure_plan', 5)
    const figures = await selectFigures(deps.pool, job.courseId, chapterFilter(job.options.chapterIds))
    if (figures.length === 0) {
      await progress('finalize', 100)
      return
    }

    const budget = await readImageBudget(deps.pool, job.courseId)
    let done = 0
    for (const figure of figures) {
      if (signal.aborted) throw new JobCanceledError()
      // 预算耗尽时保留剩余图为 planned，任务本身成功；补额度后可再跑一次。
      if (figure.kind === 'generated' && !canSpend(budget, resolved.priceMicros)) break
      await renderFigure(deps, figure, resolved, budget, signal)
      done += 1
      await progress('figure_render', Math.round((done / figures.length) * 95))
    }
    await progress('finalize', 100)
  }
}
