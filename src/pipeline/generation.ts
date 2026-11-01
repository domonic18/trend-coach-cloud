import type { Pool } from 'pg'
import type { PipelineConfig } from '../config.js'
import { assertSafeMarkdown, MAX_ARTICLE } from '../content/service.js'
import { codePointLength } from '../http/validation.js'
import {
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  PIPELINE_ERRORS,
  PROMPT_VERSION,
  REVIEW_REASONS,
  WINDOW_OVERLAP_MS,
} from './constants.js'
import { JobCanceledError, PipelineFailure } from './failures.js'
import { randomId } from './ids.js'
import type { PipelineJob } from './jobs.js'
import { LlmError, type LlmClient } from './llm.js'
import {
  articlePrompt,
  chapterPrompt,
  parseArticleResponse,
  parseChapterResponse,
  parsePointResponse,
  pointPrompt,
  type PromptRequest,
} from './prompts.js'
import { joinText, locateExcerpt, normalizeForMatch, splitTextByChars, truncateText } from './text.js'
import type {
  ChapterDraft,
  GenerationPayload,
  KnowledgePointDraft,
  SegmentDraft,
  TranscriptSegment,
} from './types.js'
import type { GenerationHook } from './worker.js'

const ARTICLE_INPUT_MAX_CHARS = 60_000

export interface GenerationDeps {
  pool: Pool
  config: PipelineConfig
  llm: LlmClient
  model: string
}

interface GenerationWindow {
  index: number
  segments: TranscriptSegment[]
}

interface PointDraft {
  key: string
  chapterKey: string
  title: string
  position: number
  confidence: number
  needsReview: boolean
  reviewReasons: string[]
  articleMarkdown: string | null
  startMs: number
  endMs: number
}

interface Piece {
  startMs: number
  endMs: number
  text: string
}

interface TranscriptRow {
  transcript_id: string
  status: string
}

interface SegmentRow {
  start_ms: string | number
  end_ms: string | number
  text: string
}

function milliseconds(value: string | number): number {
  return typeof value === 'number' ? value : Number(value)
}

function mapLlmError(error: unknown): PipelineFailure {
  if (error instanceof JobCanceledError) throw error
  if (error instanceof LlmError) {
    if (error.kind === 'unavailable' || error.kind === 'rate_limited') {
      return new PipelineFailure(PIPELINE_ERRORS.llmUnavailable, true)
    }
    return new PipelineFailure(PIPELINE_ERRORS.generationFailed, false)
  }
  if (error instanceof PipelineFailure) return error
  return new PipelineFailure(PIPELINE_ERRORS.generationFailed, false)
}

async function ask<T>(
  deps: GenerationDeps,
  request: PromptRequest,
  parse: (value: unknown) => T,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await deps.llm.completeJson({ ...request, signal }, parse)
  } catch (error) {
    throw mapLlmError(error)
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        if (signal.aborted) throw new JobCanceledError()
        const index = cursor
        cursor += 1
        const item = items[index]
        if (item === undefined) return
        results[index] = await task(item, index)
      }
    },
  )
  await Promise.all(runners)
  return results
}

/** 窗口固定时长，起点对齐到转写片段，保证相邻窗口至少共享一个片段。 */
export function buildGenerationWindows(
  segments: TranscriptSegment[],
  windowSec: number,
  overlapMs: number,
  maxWindows: number,
): GenerationWindow[] {
  const first = segments[0]
  const last = segments[segments.length - 1]
  if (first === undefined || last === undefined) return []

  const windowMs = Math.max(1000, windowSec * 1000)
  const endLimit = last.endMs
  const windows: GenerationWindow[] = []
  let startMs = first.startMs

  while (startMs < endLimit) {
    const endMs = Math.min(endLimit, startMs + windowMs)
    const items = segments.filter(segment => segment.endMs > startMs && segment.startMs < endMs)
    if (items.length > 0) windows.push({ index: windows.length, segments: items })
    if (endMs >= endLimit) break
    const boundary = segments.find(segment => segment.startMs >= endMs - overlapMs)
    startMs = Math.max(startMs + 1000, boundary?.startMs ?? endMs - overlapMs)
  }

  if (windows.length > maxWindows) {
    throw new PipelineFailure(PIPELINE_ERRORS.budgetExceeded, false)
  }
  return windows
}

function splitPiece(piece: Piece, maxMs: number): Piece[] {
  if (piece.endMs - piece.startMs <= maxMs && codePointLength(piece.text) <= MAX_TEXT_CHARS) {
    return [piece]
  }
  const duration = piece.endMs - piece.startMs
  const parts = Math.max(1, Math.ceil(duration / maxMs))
  const limit = Math.max(1, Math.floor(MAX_TEXT_CHARS / parts))
  const texts = splitTextByChars(piece.text, Math.min(MAX_TEXT_CHARS, limit))
  const totalChars = texts.reduce((sum, text) => sum + codePointLength(text), 0) || 1

  const result: Piece[] = []
  let cursor = piece.startMs
  for (const [index, text] of texts.entries()) {
    const isLast = index === texts.length - 1
    const share = Math.round((duration * codePointLength(text)) / totalChars)
    const end = isLast
      ? piece.endMs
      : Math.min(piece.endMs, Math.max(cursor + 1, cursor + share))
    result.push({ startMs: cursor, endMs: Math.max(cursor + 1, end), text })
    cursor = end
  }
  return result
}

/** 片段只在转写片段边界切分，合并后同时受时长与字数上限约束。 */
export function buildSegmentDrafts(
  points: { key: string; title: string; startMs: number; endMs: number }[],
  segments: TranscriptSegment[],
  maxSec: number,
): SegmentDraft[] {
  const maxMs = Math.max(1000, maxSec * 1000)
  const drafts: SegmentDraft[] = []

  for (const point of points) {
    const pieces = segments
      .filter(segment => segment.endMs > point.startMs && segment.startMs < point.endMs)
      .map(segment => ({
        startMs: Math.max(segment.startMs, point.startMs),
        endMs: Math.min(segment.endMs, point.endMs),
        text: segment.text,
      }))
      .filter(piece => piece.endMs > piece.startMs && piece.text.trim() !== '')
      .flatMap(piece => splitPiece(piece, maxMs))

    let current: Piece | null = null
    const flush = (): void => {
      if (current === null) return
      const index = drafts.length + 1
      drafts.push({
        key: `sg${String(index).padStart(4, '0')}`,
        pointKey: point.key,
        title: truncateText(`${point.title}（${index}）`, MAX_TITLE_CHARS),
        startMs: current.startMs,
        endMs: current.endMs,
        text: current.text,
      })
      current = null
    }

    for (const piece of pieces) {
      if (current !== null) {
        const mergedText = joinText(current.text, piece.text)
        if (piece.endMs - current.startMs <= maxMs && codePointLength(mergedText) <= MAX_TEXT_CHARS) {
          current.endMs = piece.endMs
          current.text = mergedText
          continue
        }
        flush()
      }
      current = { ...piece }
    }
    flush()
  }

  return drafts
}

function pointsInRange(
  segments: TranscriptSegment[],
  startMs: number,
  endMs: number,
): TranscriptSegment[] {
  return segments
    .filter(segment => segment.endMs > startMs && segment.startMs < endMs)
    .map(segment => ({
      startMs: Math.max(segment.startMs, startMs),
      endMs: Math.min(segment.endMs, endMs),
      text: segment.text,
    }))
}

async function writeGeneration(
  deps: GenerationDeps,
  job: PipelineJob,
  transcriptId: string,
  payload: GenerationPayload,
): Promise<string> {
  const needsReview = payload.knowledgePoints.filter(point => point.needsReview).length
  const generationId = randomId('gen')
  const { rows } = await deps.pool.query<{ generation_id: string }>(
    `INSERT INTO content_generations
       (generation_id, asset_id, transcript_id, course_id, job_id, status, prompt_version, model,
        chapters, knowledge_points, segments, needs_review, payload)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, $12::jsonb)
     RETURNING generation_id`,
    [
      generationId,
      job.assetId,
      transcriptId,
      job.courseId,
      job.jobId,
      PROMPT_VERSION,
      deps.model,
      payload.chapters.length,
      payload.knowledgePoints.length,
      payload.segments.length,
      needsReview,
      JSON.stringify(payload),
    ],
  )
  const row = rows[0]
  if (row === undefined) throw new PipelineFailure(PIPELINE_ERRORS.internal, true)
  return row.generation_id
}

export function createGenerationHook(deps: GenerationDeps): GenerationHook {
  return async (job, signal, progress) => {
    const { config, pool } = deps

    const { rows: transcriptRows } = await pool.query<TranscriptRow>(
      'SELECT transcript_id, status FROM media_transcripts WHERE asset_id = $1',
      [job.assetId],
    )
    const transcript = transcriptRows[0]
    if (transcript === undefined || transcript.status !== 'ready') {
      throw new PipelineFailure(PIPELINE_ERRORS.generationFailed, false)
    }

    const { rows: segmentRows } = await pool.query<SegmentRow>(
      `SELECT start_ms, end_ms, text FROM transcript_segments
       WHERE transcript_id = $1 ORDER BY idx`,
      [transcript.transcript_id],
    )
    const segments: TranscriptSegment[] = segmentRows.map(row => ({
      startMs: milliseconds(row.start_ms),
      endMs: milliseconds(row.end_ms),
      text: row.text,
    }))
    if (segments.length === 0) throw new PipelineFailure(PIPELINE_ERRORS.generationFailed, false)

    // 同一素材只保留一份草稿；能被新任务覆盖的一定是上次失败留下的。
    await pool.query(
      `DELETE FROM content_generations WHERE asset_id = $1 AND status = 'draft'`,
      [job.assetId],
    )

    const windows = buildGenerationWindows(
      segments,
      config.generationWindowSec,
      WINDOW_OVERLAP_MS,
      config.generationMaxWindows,
    )
    if (windows.length === 0) throw new PipelineFailure(PIPELINE_ERRORS.generationFailed, false)

    await progress('structure', 5)
    const windowChapters = await mapLimit(
      windows,
      config.llmConcurrency,
      signal,
      window => ask(deps, chapterPrompt(window.segments), parseChapterResponse, signal),
    )

    const chapterDrafts: ChapterDraft[] = []
    const chapterByTitle = new Map<string, string>()
    for (const chapters of windowChapters) {
      for (const chapter of chapters) {
        const normalized = normalizeForMatch(chapter.title)
        if (chapterByTitle.has(normalized)) continue
        const key = `ch${String(chapterDrafts.length + 1).padStart(2, '0')}`
        chapterDrafts.push({ key, title: chapter.title, position: chapterDrafts.length })
        chapterByTitle.set(normalized, key)
      }
    }
    await progress('structure', 25)

    const windowPoints = await mapLimit(
      windows,
      config.llmConcurrency,
      signal,
      (window, index) => {
        const titles = (windowChapters[index] ?? []).map(chapter => chapter.title)
        return ask(deps, pointPrompt(window.segments, titles), parsePointResponse, signal)
      },
    )
    await progress('structure', 45)

    const points: PointDraft[] = []
    const seenTitles = new Set<string>()
    for (const [windowIndex, suggestions] of windowPoints.entries()) {
      const window = windows[windowIndex]
      if (window === undefined) continue
      const windowTitles = (windowChapters[windowIndex] ?? []).map(chapter => chapter.title)
      for (const suggestion of suggestions) {
        const normalized = normalizeForMatch(suggestion.title)
        if (seenTitles.has(normalized)) continue

        let range = locateExcerpt(window.segments, suggestion.excerpt)
        const excerptFound = range !== null
        if (range === null) range = locateExcerpt(window.segments, suggestion.title)
        if (range === null) continue

        if (points.length >= config.generationMaxKps) {
          throw new PipelineFailure(PIPELINE_ERRORS.budgetExceeded, false)
        }

        let chapterKey: string | undefined
        const direct = chapterByTitle.get(normalizeForMatch(suggestion.chapterTitle))
        if (direct !== undefined) {
          chapterKey = direct
        } else {
          for (const title of windowTitles) {
            const key = chapterByTitle.get(normalizeForMatch(title))
            if (key !== undefined) {
              chapterKey = key
              break
            }
          }
        }
        chapterKey ??= chapterDrafts[0]?.key
        if (chapterKey === undefined) throw new PipelineFailure(PIPELINE_ERRORS.internal, true)

        const reviewReasons: string[] = []
        if (!excerptFound) reviewReasons.push(REVIEW_REASONS.excerptNotFound)
        if (suggestion.confidence < config.generationMinConfidence) {
          reviewReasons.push(REVIEW_REASONS.lowConfidence)
        }

        seenTitles.add(normalized)
        points.push({
          key: `kp${String(points.length + 1).padStart(2, '0')}`,
          chapterKey,
          title: suggestion.title,
          position: points.length,
          confidence: suggestion.confidence,
          needsReview: reviewReasons.length > 0,
          reviewReasons,
          articleMarkdown: null,
          startMs: range.startMs,
          endMs: range.endMs,
        })
      }
    }

    if (points.length === 0) throw new PipelineFailure(PIPELINE_ERRORS.generationFailed, false)
    if (points.length > config.generationMaxArticles) {
      throw new PipelineFailure(PIPELINE_ERRORS.budgetExceeded, false)
    }

    await progress('generate', 55)
    const segmentDrafts = buildSegmentDrafts(
      points.map(point => ({
        key: point.key,
        title: point.title,
        startMs: point.startMs,
        endMs: point.endMs,
      })),
      segments,
      config.segmentDraftMaxSec,
    )
    if (segmentDrafts.length === 0) throw new PipelineFailure(PIPELINE_ERRORS.generationFailed, false)
    await progress('generate', 60)

    let completed = 0
    await mapLimit(points, config.llmConcurrency, signal, async point => {
      const relevant = pointsInRange(segments, point.startMs, point.endMs)
      const input = truncateText(relevant.map(segment => segment.text).join('\n'), ARTICLE_INPUT_MAX_CHARS)
      let markdown: string | null = null
      for (let attempt = 0; attempt < 2 && markdown === null; attempt += 1) {
        if (signal.aborted) throw new JobCanceledError()
        try {
          const candidate = await ask(
            deps,
            articlePrompt(point.title, [{ startMs: point.startMs, endMs: point.endMs, text: input }]),
            parseArticleResponse,
            signal,
          )
          if (codePointLength(candidate) > MAX_ARTICLE) throw new Error('article too long')
          assertSafeMarkdown(candidate)
          markdown = candidate
        } catch (error) {
          if (error instanceof JobCanceledError || signal.aborted) throw new JobCanceledError()
        }
      }
      if (markdown === null) {
        point.articleMarkdown = null
        point.needsReview = true
        point.reviewReasons.push(REVIEW_REASONS.articleInvalid)
      } else {
        point.articleMarkdown = markdown
      }
      completed += 1
      await progress('generate', 60 + Math.round((completed / points.length) * 30))
    })

    await progress('finalize', 95)
    if (signal.aborted) throw new JobCanceledError()

    const payload: GenerationPayload = {
      chapters: chapterDrafts,
      knowledgePoints: points.map<KnowledgePointDraft>(point => ({
        key: point.key,
        chapterKey: point.chapterKey,
        title: point.title,
        position: point.position,
        confidence: point.confidence,
        needsReview: point.needsReview,
        reviewReasons: point.reviewReasons,
        articleMarkdown: point.articleMarkdown,
      })),
      segments: segmentDrafts,
    }
    await writeGeneration(deps, job, transcript.transcript_id, payload)
    await progress('finalize', 100)
  }
}
