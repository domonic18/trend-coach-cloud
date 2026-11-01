import type { Pool } from 'pg'
import type { AiRouter } from '../ai/routing.js'
import type { LlmTaskKey } from '../ai/tasks.js'
import type { AiRunHandle } from '../ai/usage.js'
import type { PipelineConfig } from '../config.js'
import { assertSafeMarkdown, MAX_ARTICLE } from '../content/service.js'
import { codePointLength } from '../http/validation.js'
import {
  ARTICLE_CONTEXT_MS,
  CHAPTER_ARTICLE_MIN_CHARS,
  MAX_FIGURES_PER_CHAPTER,
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
  chapterArticlePrompt,
  figurePlanPrompt,
  outlinePrompt,
  parseChapterArticleResponse,
  parseChapterResponse,
  parseFigurePlanResponse,
  parsePointResponse,
  pointPrompt,
  type FigurePlanSuggestion,
  type PromptRequest,
} from './prompts.js'
import { joinText, locateExcerpt, normalizeForMatch, splitTextByChars, truncateText } from './text.js'
import type {
  ChapterArticleDraft,
  ChapterDraft,
  FigureDraft,
  GenerationPayload,
  KnowledgePointDraft,
  SegmentDraft,
  TranscriptSegment,
} from './types.js'
import type { GenerationHook } from './worker.js'

const ARTICLE_INPUT_MAX_CHARS = 60_000

/** 每个生成任务开始时解析当前后台配置；未配置时返回 undefined。 */
export interface ResolvedContentLlm {
  llm: LlmClient
  model: string
}

export interface GenerationDeps {
  pool: Pool
  config: PipelineConfig
  resolveLlm: () => Promise<ResolvedContentLlm | undefined>
  /** 生产环境注入：按任务绑定模型、计量并支持主备切换；缺省走单一模型直连。 */
  ai?: AiRouter
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
  llm: LlmClient,
  request: PromptRequest,
  parse: (value: unknown) => T,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await llm.completeJson({ ...request, signal }, parse)
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

/** 全局大纲只看转写节选：均匀采样，避免长视频超出模型输入上限。 */
export function buildOutlineDigest(
  segments: TranscriptSegment[],
  maxSentences = 150,
): TranscriptSegment[] {
  if (segments.length <= maxSentences) return segments
  return Array.from(
    { length: maxSentences },
    (_, index) => segments[Math.floor((index * segments.length) / maxSentences)],
  ).filter((segment): segment is TranscriptSegment => segment !== undefined)
}

/** 窗口没有命中任何给定章节时，按时长比例落到对应章节，避免全部堆进第一章。 */
function chapterIndexForWindow(windowIndex: number, windowCount: number, chapterCount: number): number {
  if (chapterCount <= 1) return 0
  return Math.min(chapterCount - 1, Math.floor((windowIndex / windowCount) * chapterCount))
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
  model: string,
): Promise<string> {
  const needsReview = payload.knowledgePoints.filter(point => point.needsReview).length
    + payload.chapterArticles.filter(article => article.needsReview).length
    + payload.figures.filter(figure => figure.needsReview).length
  const generationId = randomId('gen')
  const { rows } = await deps.pool.query<{ generation_id: string }>(
    `INSERT INTO content_generations
       (generation_id, asset_id, transcript_id, course_id, job_id, status, prompt_version, model,
        chapters, knowledge_points, chapter_articles, figures, segments, needs_review, payload)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     RETURNING generation_id`,
    [
      generationId,
      job.assetId,
      transcriptId,
      job.courseId,
      job.jobId,
      PROMPT_VERSION,
      model,
      payload.chapters.length,
      payload.knowledgePoints.length,
      payload.chapterArticles.filter(article => article.markdown !== null).length,
      payload.figures.length,
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

    const resolved = await deps.resolveLlm()
    if (resolved === undefined) throw new PipelineFailure(PIPELINE_ERRORS.llmUnavailable, false)
    const { llm, model } = resolved
    const ai = deps.ai

    const call = async <T>(
      taskKey: LlmTaskKey,
      request: PromptRequest,
      parse: (value: unknown) => T,
      handle: AiRunHandle | undefined,
    ): Promise<{ value: T; model: string }> => {
      if (ai === undefined) {
        return { value: await ask(llm, request, parse, signal), model }
      }
      try {
        return await ai.completeJson(handle, taskKey, { ...request, signal }, parse)
      } catch (error) {
        throw mapLlmError(error)
      }
    }

    /** 每个阶段一条运行记录：失败只标该阶段，不影响其他阶段已产生的用量。 */
    const withRun = async <T>(
      taskKey: LlmTaskKey,
      run: (handle: AiRunHandle | undefined) => Promise<T>,
    ): Promise<T> => {
      if (ai === undefined) return run(undefined)
      const handle = await ai.startRun(taskKey, 'pipeline', job.jobId)
      try {
        const result = await run(handle)
        await ai.finishRun(handle, 'succeeded')
        return result
      } catch (error) {
        const code = error instanceof PipelineFailure ? error.code : 'internal'
        await ai.finishRun(handle, 'failed', { errorCode: code }).catch(() => undefined)
        throw error
      }
    }

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
    const durationMs = Math.max(0, (segments[segments.length - 1]?.endMs ?? 0) - (segments[0]?.startMs ?? 0))
    const outline = (await withRun('content.outline', handle => call(
      'content.outline',
      outlinePrompt(buildOutlineDigest(segments), durationMs),
      parseChapterResponse,
      handle,
    ))).value

    const chapterDrafts: ChapterDraft[] = []
    const chapterByTitle = new Map<string, string>()
    for (const chapter of outline) {
      const normalized = normalizeForMatch(chapter.title)
      if (chapterByTitle.has(normalized)) continue
      const key = `ch${String(chapterDrafts.length + 1).padStart(2, '0')}`
      chapterDrafts.push({ key, title: chapter.title, position: chapterDrafts.length })
      chapterByTitle.set(normalized, key)
    }
    if (chapterDrafts.length === 0) throw new PipelineFailure(PIPELINE_ERRORS.generationFailed, false)
    const chapterTitles = chapterDrafts.map(chapter => chapter.title)
    await progress('structure', 25)

    const windowPoints = await withRun('content.points', handle => mapLimit(
      windows,
      config.llmConcurrency,
      signal,
      async window => (await call(
        'content.points',
        pointPrompt(window.segments, chapterTitles),
        parsePointResponse,
        handle,
      )).value,
    ))
    await progress('structure', 45)

    const points: PointDraft[] = []
    const seenTitles = new Set<string>()
    const seenRanges = new Map<string, string[]>()
    for (const [windowIndex, suggestions] of windowPoints.entries()) {
      const window = windows[windowIndex]
      if (window === undefined) continue
      for (const suggestion of suggestions) {
        const normalized = normalizeForMatch(suggestion.title)
        if (seenTitles.has(normalized)) continue

        let range = locateExcerpt(window.segments, suggestion.excerpt)
        const excerptFound = range !== null
        if (range === null) range = locateExcerpt(window.segments, suggestion.title)
        if (range === null) continue

        // 同一时间段常被重复提取：措辞不同但摘录互相包含的视为同一知识点。
        const rangeKey = `${range.startMs}:${range.endMs}`
        const excerptKey = normalizeForMatch(suggestion.excerpt)
        const priorExcerpts = seenRanges.get(rangeKey) ?? []
        if (
          excerptKey !== '' &&
          priorExcerpts.some(text => text.includes(excerptKey) || excerptKey.includes(text))
        ) {
          continue
        }

        if (points.length >= config.generationMaxKps) {
          throw new PipelineFailure(PIPELINE_ERRORS.budgetExceeded, false)
        }

        const chapterKey = chapterByTitle.get(normalizeForMatch(suggestion.chapterTitle))
          ?? chapterDrafts[chapterIndexForWindow(windowIndex, windows.length, chapterDrafts.length)]?.key
        if (chapterKey === undefined) throw new PipelineFailure(PIPELINE_ERRORS.internal, true)

        const reviewReasons: string[] = []
        if (!excerptFound) reviewReasons.push(REVIEW_REASONS.excerptNotFound)
        if (suggestion.confidence < config.generationMinConfidence) {
          reviewReasons.push(REVIEW_REASONS.lowConfidence)
        }

        seenTitles.add(normalized)
        if (excerptKey !== '') seenRanges.set(rangeKey, [...priorExcerpts, excerptKey])
        points.push({
          key: `kp${String(points.length + 1).padStart(2, '0')}`,
          chapterKey,
          title: suggestion.title,
          position: points.length,
          confidence: suggestion.confidence,
          needsReview: reviewReasons.length > 0,
          reviewReasons,
          startMs: range.startMs,
          endMs: range.endMs,
        })
      }
    }

    if (points.length === 0) throw new PipelineFailure(PIPELINE_ERRORS.generationFailed, false)
    if (points.length > config.generationMaxArticles) {
      throw new PipelineFailure(PIPELINE_ERRORS.budgetExceeded, false)
    }

    // 全局大纲里没有被任何知识点命中的章节丢弃，避免学员点进空章。
    const usedChapterKeys = new Set(points.map(point => point.chapterKey))
    const keptChapters = chapterDrafts.filter(chapter => usedChapterKeys.has(chapter.key))
    const chapterKeyMap = new Map<string, string>()
    keptChapters.forEach((chapter, index) => {
      const key = `ch${String(index + 1).padStart(2, '0')}`
      chapterKeyMap.set(chapter.key, key)
      chapter.key = key
      chapter.position = index
    })
    for (const point of points) {
      point.chapterKey = chapterKeyMap.get(point.chapterKey) ?? keptChapters[0]?.key ?? point.chapterKey
    }
    chapterDrafts.splice(0, chapterDrafts.length, ...keptChapters)

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

    const pointsByChapter = new Map<string, PointDraft[]>()
    for (const point of points) {
      const list = pointsByChapter.get(point.chapterKey) ?? []
      list.push(point)
      pointsByChapter.set(point.chapterKey, list)
    }
    // 每章只取一次转写上下文，图示规划与教材写作共用，避免重复截取。
    const chapterContext = new Map<string, TranscriptSegment[]>()
    for (const chapter of chapterDrafts) {
      const list = pointsByChapter.get(chapter.key) ?? []
      if (list.length === 0) {
        chapterContext.set(chapter.key, [])
        continue
      }
      const startMs = Math.max(0, Math.min(...list.map(point => point.startMs)) - ARTICLE_CONTEXT_MS)
      const endMs = Math.max(...list.map(point => point.endMs)) + ARTICLE_CONTEXT_MS
      chapterContext.set(chapter.key, pointsInRange(segments, startMs, endMs))
    }

    let generatedModel = model
    await progress('figure_plan', 65)
    const plans = await withRun('content.figure_plan', handle => mapLimit(
      chapterDrafts,
      config.llmConcurrency,
      signal,
      async chapter => {
        const context = chapterContext.get(chapter.key) ?? []
        if (context.length === 0) return [] as FigurePlanSuggestion[]
        try {
          const result = await call(
            'content.figure_plan',
            figurePlanPrompt(chapter.title, context),
            parseFigurePlanResponse,
            handle,
          )
          generatedModel = result.model
          return result.value
        } catch (error) {
          if (error instanceof JobCanceledError || signal.aborted) throw new JobCanceledError()
          // 图示是增强项：规划失败只影响本章图示，不阻塞教材。
          return [] as FigurePlanSuggestion[]
        }
      },
    ))
    await progress('figure_plan', 72)

    const figures: FigureDraft[] = []
    const figuresByChapter = new Map<string, FigureDraft[]>()
    chapterDrafts.forEach((chapter, index) => {
      const context = chapterContext.get(chapter.key) ?? []
      const seenCaptions = new Set<string>()
      for (const suggestion of (plans[index] ?? []).slice(0, MAX_FIGURES_PER_CHAPTER)) {
        const caption = suggestion.caption.trim()
        const normalizedCaption = normalizeForMatch(caption)
        if (normalizedCaption === '' || seenCaptions.has(normalizedCaption)) continue
        let sourceMs: number | null = null
        if (suggestion.kind === 'keyframe') {
          const hint = suggestion.sourceHint === null ? null : locateExcerpt(context, suggestion.sourceHint)
          if (hint === null) continue
          sourceMs = hint.startMs
        }
        seenCaptions.add(normalizedCaption)
        const draft: FigureDraft = {
          key: `fg${String(figures.length + 1).padStart(2, '0')}`,
          chapterKey: chapter.key,
          kind: suggestion.kind,
          caption,
          prompt: suggestion.kind === 'generated' ? suggestion.prompt : null,
          sourceMs,
          needsReview: false,
          reviewReasons: [],
        }
        figures.push(draft)
        const list = figuresByChapter.get(chapter.key) ?? []
        list.push(draft)
        figuresByChapter.set(chapter.key, list)
      }
    })

    await progress('generate', 75)
    let completed = 0
    const articles = await withRun('content.chapter_article', handle => mapLimit(
      chapterDrafts,
      config.llmConcurrency,
      signal,
      async chapter => {
        const context = chapterContext.get(chapter.key) ?? []
        const chapterFigures = figuresByChapter.get(chapter.key) ?? []
        const chapterPoints = pointsByChapter.get(chapter.key) ?? []
        const input = truncateText(context.map(segment => segment.text).join('\n'), ARTICLE_INPUT_MAX_CHARS)
        const window: TranscriptSegment[] = [{
          startMs: context[0]?.startMs ?? 0,
          endMs: context[context.length - 1]?.endMs ?? 0,
          text: input,
        }]
        let markdown: string | null = null
        let used = new Set<string>()
        for (let attempt = 0; attempt < 2 && markdown === null; attempt += 1) {
          if (signal.aborted) throw new JobCanceledError()
          try {
            const result = await call(
              'content.chapter_article',
              chapterArticlePrompt(
                chapter.title,
                chapterPoints.map(point => ({ title: point.title })),
                window,
                chapterFigures.map(figure => ({ key: figure.key, caption: figure.caption })),
              ),
              parseChapterArticleResponse,
              handle,
            )
            const candidate = result.value
            if (codePointLength(candidate) > MAX_ARTICLE) throw new Error('chapter article too long')
            assertSafeMarkdown(candidate)
            const sanitized = sanitizeChapterMarkdown(candidate, chapterFigures)
            if (sanitized.markdown === '') throw new Error('chapter article empty')
            markdown = sanitized.markdown
            used = sanitized.used
            generatedModel = result.model
          } catch (error) {
            if (error instanceof JobCanceledError || signal.aborted) throw new JobCanceledError()
          }
        }
        completed += 1
        await progress('generate', 75 + Math.round((completed / chapterDrafts.length) * 20))
        const reviewReasons: string[] = []
        if (markdown === null) {
          reviewReasons.push(REVIEW_REASONS.chapterArticleInvalid)
        } else if (codePointLength(markdown) < CHAPTER_ARTICLE_MIN_CHARS) {
          reviewReasons.push(REVIEW_REASONS.chapterArticleShort)
        }
        const draft: ChapterArticleDraft = {
          chapterKey: chapter.key,
          markdown,
          needsReview: reviewReasons.length > 0,
          reviewReasons,
        }
        return { draft, used }
      },
    ))

    // 正文没有引用的图不进入产物：避免 illustrate 为无用图付费。
    const usedFigureKeys = new Set(articles.flatMap(item => [...item.used]))
    const retainedFigures = figures.filter(figure => usedFigureKeys.has(figure.key))

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
      })),
      segments: segmentDrafts,
      chapterArticles: articles.map(item => item.draft),
      figures: retainedFigures,
    }
    await writeGeneration(deps, job, transcript.transcript_id, payload, generatedModel)
    await progress('finalize', 100)
  }
}

const INLINE_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g
const FIGURE_LINE = /^!\[([^\]\n]*)\]\(figure:([A-Za-z0-9._-]{1,64})\)$/

/** 只保留本章已有图示的独立引用行；外链图片、未知图示与内嵌图片整行丢弃。 */
function sanitizeChapterMarkdown(
  markdown: string,
  figures: FigureDraft[],
): { markdown: string; used: Set<string> } {
  const valid = new Set(figures.map(figure => figure.key))
  const used = new Set<string>()
  const lines: string[] = []
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    const match = FIGURE_LINE.exec(trimmed)
    if (match !== null && valid.has(match[2]!)) {
      lines.push(trimmed)
      used.add(match[2]!)
      continue
    }
    if (match !== null) continue
    lines.push(line.replace(INLINE_IMAGE, ''))
  }
  return {
    markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    used,
  }
}
