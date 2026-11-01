import type { Pool } from 'pg'
import { badRequest, conflict, HttpError, notFound } from '../errors.js'
import { codePointLength, stringField } from '../http/validation.js'
import { toVectorLiteral, type EmbeddingResolver } from '../kb/embedding.js'
import {
  assertPublishableQuestions,
  parseQuizQuestions,
  type QuizQuestion,
} from './quiz.js'

export const CONTENT_STATUSES = ['draft', 'published', 'archived'] as const
export type ContentStatus = (typeof CONTENT_STATUSES)[number]

const ID = /^[A-Za-z0-9._-]{1,64}$/
export const SEGMENT_ID = /^seg-[A-Za-z0-9._-]{1,76}$/
export const MAX_TITLE = 200
export const MAX_TEXT = 4000
export const MAX_ARTICLE = 20000
const MAX_QUERY = 100
const MAX_START = 86400
const MAX_END = 86400
const MAX_POSITION = 10000

const EXECUTABLE_HTML = [
  /<\s*script\b/i,
  /<\s*iframe\b/i,
  /<\s*object\b/i,
  /<\s*embed\b/i,
  /<\s*style\b/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
  /data\s*:\s*text\/html/i,
]

export interface AdminCourse {
  courseId: string
  title: string
  status: ContentStatus
}

export interface AdminCourseSummary extends AdminCourse {
  chapterCount: number
  knowledgePointCount: number
  segmentCount: number
  chapterArticleCount: number
  figureCount: number
}

export interface AdminArticleMeta {
  version: number
  status: ContentStatus
  publishedAt: number | null
}

export interface AdminArticle extends AdminArticleMeta {
  markdown: string
}

export interface AdminQuiz extends AdminArticleMeta {
  questions: QuizQuestion[]
}

export interface AdminKnowledgePoint {
  knowledgePointId: string
  title: string
  position: number
  segmentCount: number
}

export interface AdminChapter {
  chapterId: string
  title: string
  position: number
}

export interface AdminChapterTree extends AdminChapter {
  article: AdminArticleMeta | null
  quiz: AdminArticleMeta | null
  figureCount: number
  knowledgePoints: AdminKnowledgePoint[]
}

export interface AdminCourseTree {
  course: AdminCourse
  chapters: AdminChapterTree[]
}

export interface AdminSegment {
  segmentId: string
  courseId: string
  chapterId: string
  knowledgePointId: string
  title: string
  startSec: number
  endSec: number
  text: string
  status: ContentStatus
  hasEmbedding: boolean
}

export interface SegmentFilters {
  courseId?: string
  knowledgePointId?: string
  status?: ContentStatus
  query?: string
  offset: number
  limit: number
}

interface CourseRow {
  course_id: string
  title: string
  status: ContentStatus
}

interface CourseSummaryRow extends CourseRow {
  chapter_count: number
  knowledge_point_count: number
  segment_count: number
  chapter_article_count: number
  figure_count: number
}

interface ChapterRow {
  chapter_id: string
  title: string
  position: number
}

interface PointRow {
  knowledge_point_id: string
  chapter_id: string
  title: string
  position: number
  segment_count: number
}

interface SegmentDbRow {
  segment_id: string
  course_id: string
  chapter_id: string
  knowledge_point_id: string
  title: string
  start_sec: number
  end_sec: number
  text: string
  status: ContentStatus
  has_embedding: boolean
}

interface ArticleRow {
  markdown: string
  version: number
  status: ContentStatus
  published_at: Date | null
}

interface ChapterArticleMetaRow {
  chapter_id: string
  version: number
  status: ContentStatus
  published_at: Date | null
}

interface QuizRow {
  questions: unknown
  version: number
  status: ContentStatus
  published_at: Date | null
}

interface ChapterFigureCountRow {
  chapter_id: string
  figure_count: number
}

const ANY_INLINE_IMAGE = /!\[([^\]\n]*)\]\(([^)\n]*)\)/g

export function parseContentId(raw: string, field: string): string {
  return stringField({ [field]: raw }, field, { max: 64, pattern: ID })
}

export function parseSegmentId(raw: string): string {
  return stringField({ segmentId: raw }, 'segmentId', { max: 80, pattern: SEGMENT_ID })
}

export function parseStatus(value: unknown, field = 'status'): ContentStatus {
  if (typeof value !== 'string' || !(CONTENT_STATUSES as readonly string[]).includes(value)) {
    throw badRequest(`${field} must be ${CONTENT_STATUSES.join('/')}`)
  }
  return value as ContentStatus
}

export function titleField(body: Record<string, unknown>, key = 'title'): string {
  return stringField(body, key, { min: 1, max: MAX_TITLE })
}

export function textField(body: Record<string, unknown>): string {
  return stringField(body, 'text', { min: 1, max: MAX_TEXT })
}

export function markdownField(body: Record<string, unknown>): string {
  const markdown = stringField(body, 'markdown', { min: 1, max: MAX_ARTICLE })
  assertSafeMarkdown(markdown)
  return markdown
}

/** Markdown 子集：拒绝可执行 HTML 与脚本协议，正文仍按纯文本渲染。 */
export function assertSafeMarkdown(markdown: string): void {
  for (const pattern of EXECUTABLE_HTML) {
    if (pattern.test(markdown)) throw badRequest('markdown must not contain executable html')
  }
}

export function secondsField(body: Record<string, unknown>, key: 'startSec' | 'endSec'): number {
  const max = key === 'startSec' ? MAX_START : MAX_END
  const min = key === 'startSec' ? 0 : 1
  const value = body[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function positionField(body: Record<string, unknown>): number | undefined {
  if (body.position === undefined) return undefined
  const value = body.position
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_POSITION) {
    throw badRequest(`position must be an integer between 0 and ${MAX_POSITION}`)
  }
  return value
}

export function boundedQuery(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  const value = stringField({ query: raw }, 'query', { max: MAX_QUERY })
  return value
}

export class ContentService {
  constructor(
    private readonly pool: Pool,
    private readonly embedding?: EmbeddingResolver,
  ) {}

  async listCourses(): Promise<{ courses: AdminCourseSummary[] }> {
    const { rows } = await this.pool.query<CourseSummaryRow>(
      `SELECT c.course_id, c.title, c.status,
              (SELECT count(*)::int FROM chapters ch WHERE ch.course_id = c.course_id) AS chapter_count,
              (SELECT count(*)::int FROM knowledge_points kp WHERE kp.course_id = c.course_id) AS knowledge_point_count,
              (SELECT count(*)::int FROM segments sg WHERE sg.course_id = c.course_id) AS segment_count,
              (SELECT count(*)::int FROM chapter_articles ca WHERE ca.course_id = c.course_id) AS chapter_article_count,
              (SELECT count(*)::int FROM figures f WHERE f.course_id = c.course_id) AS figure_count
       FROM courses c
       ORDER BY c.created_at, c.course_id`,
    )
    return {
      courses: rows.map(row => ({
        courseId: row.course_id,
        title: row.title,
        status: row.status,
        chapterCount: row.chapter_count,
        knowledgePointCount: row.knowledge_point_count,
        segmentCount: row.segment_count,
        chapterArticleCount: row.chapter_article_count,
        figureCount: row.figure_count,
      })),
    }
  }

  async createCourse(input: { courseId: string; title: string; status: ContentStatus }): Promise<AdminCourse> {
    const { rows } = await this.pool.query<CourseRow>(
      `INSERT INTO courses (course_id, title, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (course_id) DO NOTHING
       RETURNING course_id, title, status`,
      [input.courseId, input.title, input.status],
    ).catch(error => {
      throw mapDbError(error, 'course')
    })
    const row = rows[0]
    if (row === undefined) throw conflict('course already exists')
    return { courseId: row.course_id, title: row.title, status: row.status }
  }

  async getCourseTree(rawCourseId: string): Promise<AdminCourseTree> {
    const courseId = parseContentId(rawCourseId, 'courseId')
    const { rows: courseRows } = await this.pool.query<CourseRow>(
      `SELECT course_id, title, status FROM courses WHERE course_id = $1`,
      [courseId],
    )
    const course = courseRows[0]
    if (course === undefined) throw notFound('course not found')

    const { rows: chapterRows } = await this.pool.query<ChapterRow>(
      `SELECT chapter_id, title, position FROM chapters WHERE course_id = $1 ORDER BY position, chapter_id`,
      [courseId],
    )
    const { rows: pointRows } = await this.pool.query<PointRow>(
      `SELECT kp.knowledge_point_id, kp.chapter_id, kp.title, kp.position,
              (SELECT count(*)::int FROM segments sg WHERE sg.knowledge_point_id = kp.knowledge_point_id) AS segment_count
       FROM knowledge_points kp
       WHERE kp.course_id = $1
       ORDER BY kp.position, kp.knowledge_point_id`,
      [courseId],
    )

    const byChapter = new Map<string, AdminKnowledgePoint[]>()
    for (const row of pointRows) {
      const list = byChapter.get(row.chapter_id) ?? []
      list.push({
        knowledgePointId: row.knowledge_point_id,
        title: row.title,
        position: row.position,
        segmentCount: row.segment_count,
      })
      byChapter.set(row.chapter_id, list)
    }

    const { rows: articleRows } = await this.pool.query<ChapterArticleMetaRow>(
      `SELECT chapter_id, version, status, published_at
       FROM chapter_articles WHERE course_id = $1`,
      [courseId],
    )
    const articles = new Map<string, AdminArticleMeta>()
    for (const row of articleRows) {
      articles.set(row.chapter_id, {
        version: row.version,
        status: row.status,
        publishedAt: row.published_at?.getTime() ?? null,
      })
    }

    const { rows: quizRows } = await this.pool.query<ChapterArticleMetaRow>(
      `SELECT chapter_id, version, status, published_at
       FROM chapter_quizzes WHERE course_id = $1`,
      [courseId],
    )
    const quizzes = new Map<string, AdminArticleMeta>()
    for (const row of quizRows) {
      quizzes.set(row.chapter_id, {
        version: row.version,
        status: row.status,
        publishedAt: row.published_at?.getTime() ?? null,
      })
    }

    const { rows: figureRows } = await this.pool.query<ChapterFigureCountRow>(
      `SELECT chapter_id, count(*)::int AS figure_count
       FROM figures WHERE course_id = $1 GROUP BY chapter_id`,
      [courseId],
    )
    const figureCounts = new Map(figureRows.map(row => [row.chapter_id, row.figure_count]))

    return {
      course: { courseId: course.course_id, title: course.title, status: course.status },
      chapters: chapterRows.map(row => ({
        chapterId: row.chapter_id,
        title: row.title,
        position: row.position,
        article: articles.get(row.chapter_id) ?? null,
        quiz: quizzes.get(row.chapter_id) ?? null,
        figureCount: figureCounts.get(row.chapter_id) ?? 0,
        knowledgePoints: byChapter.get(row.chapter_id) ?? [],
      })),
    }
  }

  async patchCourse(
    rawCourseId: string,
    input: { title?: string; status?: ContentStatus },
  ): Promise<AdminCourse> {
    const courseId = parseContentId(rawCourseId, 'courseId')
    const { rows } = await this.pool.query<CourseRow>(
      `UPDATE courses
       SET title = COALESCE($2, title), status = COALESCE($3, status)
       WHERE course_id = $1
       RETURNING course_id, title, status`,
      [courseId, input.title ?? null, input.status ?? null],
    )
    const row = rows[0]
    if (row === undefined) throw notFound('course not found')
    return { courseId: row.course_id, title: row.title, status: row.status }
  }

  async createChapter(
    rawCourseId: string,
    input: { chapterId: string; title: string; position?: number },
  ): Promise<AdminChapter> {
    const courseId = parseContentId(rawCourseId, 'courseId')
    await this.requireCourse(courseId)
    const { rows } = await this.pool.query<ChapterRow>(
      `INSERT INTO chapters (course_id, chapter_id, title, position)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (course_id, chapter_id) DO NOTHING
       RETURNING chapter_id, title, position`,
      [courseId, input.chapterId, input.title, input.position ?? 0],
    )
    const row = rows[0]
    if (row === undefined) throw conflict('chapter already exists')
    return { chapterId: row.chapter_id, title: row.title, position: row.position }
  }

  async patchChapter(
    rawCourseId: string,
    rawChapterId: string,
    input: { title?: string; position?: number },
  ): Promise<AdminChapter> {
    const courseId = parseContentId(rawCourseId, 'courseId')
    const chapterId = parseContentId(rawChapterId, 'chapterId')
    const { rows } = await this.pool.query<ChapterRow>(
      `UPDATE chapters
       SET title = COALESCE($3, title), position = COALESCE($4, position)
       WHERE course_id = $1 AND chapter_id = $2
       RETURNING chapter_id, title, position`,
      [courseId, chapterId, input.title ?? null, input.position ?? null],
    )
    const row = rows[0]
    if (row === undefined) throw notFound('chapter not found')
    return { chapterId: row.chapter_id, title: row.title, position: row.position }
  }

  async createKnowledgePoint(
    rawCourseId: string,
    rawChapterId: string,
    input: { knowledgePointId: string; title: string; position?: number },
  ): Promise<AdminKnowledgePoint> {
    const courseId = parseContentId(rawCourseId, 'courseId')
    const chapterId = parseContentId(rawChapterId, 'chapterId')
    await this.requireChapter(courseId, chapterId)
    const { rows } = await this.pool.query<{ knowledge_point_id: string }>(
      `INSERT INTO knowledge_points (knowledge_point_id, course_id, chapter_id, title, position)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (knowledge_point_id) DO NOTHING
       RETURNING knowledge_point_id`,
      [input.knowledgePointId, courseId, chapterId, input.title, input.position ?? 0],
    )
    const row = rows[0]
    if (row === undefined) throw conflict('knowledge point already exists')
    return {
      knowledgePointId: row.knowledge_point_id,
      title: input.title,
      position: input.position ?? 0,
      segmentCount: 0,
    }
  }

  async patchKnowledgePoint(
    rawKnowledgePointId: string,
    input: { title?: string; position?: number },
  ): Promise<AdminKnowledgePoint> {
    const knowledgePointId = parseContentId(rawKnowledgePointId, 'knowledgePointId')
    const { rows } = await this.pool.query<{
      knowledge_point_id: string
      title: string
      position: number
      segment_count: number
    }>(
      `UPDATE knowledge_points kp
       SET title = COALESCE($2, kp.title), position = COALESCE($3, kp.position)
       WHERE kp.knowledge_point_id = $1
       RETURNING kp.knowledge_point_id, kp.title, kp.position,
         (SELECT count(*)::int FROM segments sg WHERE sg.knowledge_point_id = kp.knowledge_point_id) AS segment_count`,
      [knowledgePointId, input.title ?? null, input.position ?? null],
    )
    const row = rows[0]
    if (row === undefined) throw notFound('knowledge point not found')
    return {
      knowledgePointId: row.knowledge_point_id,
      title: row.title,
      position: row.position,
      segmentCount: row.segment_count,
    }
  }

  async getChapterArticle(rawCourseId: string, rawChapterId: string): Promise<AdminArticle | null> {
    const courseId = parseContentId(rawCourseId, 'courseId')
    const chapterId = parseContentId(rawChapterId, 'chapterId')
    await this.requireChapter(courseId, chapterId)
    const { rows } = await this.pool.query<ArticleRow>(
      `SELECT markdown, version, status, published_at
       FROM chapter_articles WHERE course_id = $1 AND chapter_id = $2`,
      [courseId, chapterId],
    )
    const row = rows[0]
    return row === undefined ? null : toArticle(row)
  }

  async putChapterArticle(
    rawCourseId: string,
    rawChapterId: string,
    input: { markdown: string; status: ContentStatus },
  ): Promise<AdminArticle> {
    const courseId = parseContentId(rawCourseId, 'courseId')
    const chapterId = parseContentId(rawChapterId, 'chapterId')
    await this.requireChapter(courseId, chapterId)
    await this.requireChapterFigures(courseId, chapterId, input.markdown)
    const { rows } = await this.pool.query<ArticleRow>(
      `INSERT INTO chapter_articles (course_id, chapter_id, markdown, version, status, published_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, CASE WHEN $4 = 'published' THEN now() END, now())
       ON CONFLICT (course_id, chapter_id) DO UPDATE
       SET markdown = EXCLUDED.markdown,
           version = chapter_articles.version + 1,
           status = EXCLUDED.status,
           published_at = CASE
             WHEN EXCLUDED.status = 'published' THEN now()
             ELSE chapter_articles.published_at
           END,
           updated_at = now()
       RETURNING markdown, version, status, published_at`,
      [courseId, chapterId, input.markdown, input.status],
    )
    const row = rows[0]
    if (row === undefined) throw new HttpError(500, 'chapter article save failed')
    return toArticle(row)
  }

  async getChapterQuiz(rawCourseId: string, rawChapterId: string): Promise<AdminQuiz | null> {
    const courseId = parseContentId(rawCourseId, 'courseId')
    const chapterId = parseContentId(rawChapterId, 'chapterId')
    await this.requireChapter(courseId, chapterId)
    const { rows } = await this.pool.query<QuizRow>(
      `SELECT questions, version, status, published_at
       FROM chapter_quizzes WHERE course_id = $1 AND chapter_id = $2`,
      [courseId, chapterId],
    )
    const row = rows[0]
    return row === undefined ? null : toQuiz(row)
  }

  async putChapterQuiz(
    rawCourseId: string,
    rawChapterId: string,
    input: { questions: unknown; status: ContentStatus },
  ): Promise<AdminQuiz> {
    const courseId = parseContentId(rawCourseId, 'courseId')
    const chapterId = parseContentId(rawChapterId, 'chapterId')
    await this.requireChapter(courseId, chapterId)
    const questions = parseQuizQuestions(input.questions)
    if (input.status === 'published') assertPublishableQuestions(questions)
    const { rows } = await this.pool.query<QuizRow>(
      `INSERT INTO chapter_quizzes (course_id, chapter_id, questions, version, status, published_at, updated_at)
       VALUES ($1, $2, $3::jsonb, 1, $4, CASE WHEN $4 = 'published' THEN now() END, now())
       ON CONFLICT (course_id, chapter_id) DO UPDATE
       SET questions = EXCLUDED.questions,
           version = chapter_quizzes.version + 1,
           status = EXCLUDED.status,
           published_at = CASE
             WHEN EXCLUDED.status = 'published' THEN now()
             ELSE chapter_quizzes.published_at
           END,
           updated_at = now()
       RETURNING questions, version, status, published_at`,
      [courseId, chapterId, JSON.stringify(questions), input.status],
    )
    const row = rows[0]
    if (row === undefined) throw new HttpError(500, 'chapter quiz save failed')
    return toQuiz(row)
  }

  async listSegments(filters: SegmentFilters): Promise<{
    segments: AdminSegment[]
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
    if (filters.knowledgePointId !== undefined) {
      add(index => `knowledge_point_id = $${index}`, filters.knowledgePointId)
    }
    if (filters.status !== undefined) add(index => `status = $${index}`, filters.status)
    if (filters.query !== undefined) {
      add(index => `(title ILIKE '%' || $${index} || '%' OR text ILIKE '%' || $${index} || '%')`, filters.query)
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`

    const { rows: countRows } = await this.pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM segments ${where}`,
      values,
    )
    const offsetIndex = values.length + 1
    const limitIndex = values.length + 2
    const { rows } = await this.pool.query<SegmentDbRow>(
      `SELECT segment_id, course_id, chapter_id, knowledge_point_id, title,
              start_sec, end_sec, text, status, embedding IS NOT NULL AS has_embedding
       FROM segments
       ${where}
       ORDER BY course_id, start_sec, segment_id
       OFFSET $${offsetIndex} LIMIT $${limitIndex}`,
      [...values, filters.offset, filters.limit],
    )
    return {
      segments: rows.map(toSegment),
      total: countRows[0]?.total ?? 0,
      offset: filters.offset,
      limit: filters.limit,
    }
  }

  async createSegment(input: {
    segmentId: string
    courseId: string
    chapterId: string
    knowledgePointId: string
    title: string
    startSec: number
    endSec: number
    text: string
    status: ContentStatus
  }): Promise<AdminSegment> {
    if (input.startSec >= input.endSec) throw badRequest('startSec must be less than endSec')
    await this.requireKnowledgePointIn(input.knowledgePointId, input.courseId, input.chapterId)

    const embed = await this.embedding?.resolve('embedding.segment')
    const vector = embed === undefined ? null : toVectorLiteral(await embed(input.text))
    const { rows } = await this.pool.query<SegmentDbRow>(
      `INSERT INTO segments
         (segment_id, course_id, chapter_id, knowledge_point_id, title, start_sec, end_sec, text, status, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::halfvec)
       ON CONFLICT (segment_id) DO NOTHING
       RETURNING segment_id, course_id, chapter_id, knowledge_point_id, title,
                 start_sec, end_sec, text, status, embedding IS NOT NULL AS has_embedding`,
      [
        input.segmentId,
        input.courseId,
        input.chapterId,
        input.knowledgePointId,
        input.title,
        input.startSec,
        input.endSec,
        input.text,
        input.status,
        vector,
      ],
    )
    const row = rows[0]
    if (row === undefined) throw conflict('segment already exists')
    return toSegment(row)
  }

  async patchSegment(
    rawSegmentId: string,
    input: {
      title?: string
      startSec?: number
      endSec?: number
      text?: string
      status?: ContentStatus
    },
  ): Promise<AdminSegment> {
    const segmentId = parseSegmentId(rawSegmentId)
    const { rows: currentRows } = await this.pool.query<{ start_sec: number; end_sec: number; text: string }>(
      `SELECT start_sec, end_sec, text FROM segments WHERE segment_id = $1`,
      [segmentId],
    )
    const current = currentRows[0]
    if (current === undefined) throw notFound('segment not found')

    const startSec = input.startSec ?? current.start_sec
    const endSec = input.endSec ?? current.end_sec
    if (startSec >= endSec) throw badRequest('startSec must be less than endSec')

    const textChanged = input.text !== undefined && input.text !== current.text
    const embed = textChanged ? await this.embedding?.resolve('embedding.segment') : undefined
    const vector = embed === undefined
      ? null
      : toVectorLiteral(await embed(input.text as string))

    const { rows } = await this.pool.query<SegmentDbRow>(
      `UPDATE segments
       SET title = COALESCE($2, title),
           start_sec = $3,
           end_sec = $4,
           text = COALESCE($5, text),
           status = COALESCE($6, status),
           embedding = CASE WHEN $5::text IS NOT NULL THEN $7::halfvec ELSE embedding END,
           updated_at = now()
       WHERE segment_id = $1
       RETURNING segment_id, course_id, chapter_id, knowledge_point_id, title,
                 start_sec, end_sec, text, status, embedding IS NOT NULL AS has_embedding`,
      [segmentId, input.title ?? null, startSec, endSec, input.text ?? null, input.status ?? null, vector],
    )
    const row = rows[0]
    if (row === undefined) throw notFound('segment not found')
    return toSegment(row)
  }

  async reindex(rawCourseId: string | undefined): Promise<{ embedded: number }> {
    const embed = await this.embedding?.resolve('embedding.segment')
    if (embed === undefined) throw conflict('embedding provider not configured')
    let courseId: string | undefined
    if (rawCourseId !== undefined) {
      courseId = parseContentId(rawCourseId, 'courseId')
      await this.requireCourse(courseId)
    }

    const { rows } = await this.pool.query<{ segment_id: string; text: string }>(
      `SELECT segment_id, text
       FROM segments
       WHERE status <> 'archived' ${courseId === undefined ? '' : 'AND course_id = $1'}
       ORDER BY segment_id`,
      courseId === undefined ? [] : [courseId],
    )

    let embedded = 0
    for (const row of rows) {
      const vector = toVectorLiteral(await embed(row.text))
      await this.pool.query(
        `UPDATE segments SET embedding = $2::halfvec, updated_at = now() WHERE segment_id = $1`,
        [row.segment_id, vector],
      )
      embedded += 1
    }
    return { embedded }
  }

  private async requireCourse(courseId: string): Promise<void> {
    const { rowCount } = await this.pool.query(`SELECT 1 FROM courses WHERE course_id = $1`, [courseId])
    if (rowCount === 0) throw notFound('course not found')
  }

  private async requireChapter(courseId: string, chapterId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM chapters WHERE course_id = $1 AND chapter_id = $2`,
      [courseId, chapterId],
    )
    if (rowCount === 0) throw notFound('chapter not found')
  }

  /** 正文只允许引用本章已存在的 figure，避免跨章引用或外链图片绕过签名。 */
  private async requireChapterFigures(
    courseId: string,
    chapterId: string,
    markdown: string,
  ): Promise<void> {
    const { rows } = await this.pool.query<{ figure_id: string }>(
      `SELECT figure_id FROM figures WHERE course_id = $1 AND chapter_id = $2`,
      [courseId, chapterId],
    )
    const owned = new Set(rows.map(row => row.figure_id))
    for (const match of markdown.matchAll(ANY_INLINE_IMAGE)) {
      const target = match[2] ?? ''
      if (!target.startsWith('figure:') || !owned.has(target.slice('figure:'.length))) {
        throw badRequest('markdown images must reference figures in this chapter')
      }
    }
  }

  private async requireKnowledgePointIn(
    knowledgePointId: string,
    courseId: string,
    chapterId: string,
  ): Promise<void> {
    const { rows } = await this.pool.query<{ course_id: string; chapter_id: string }>(
      `SELECT course_id, chapter_id FROM knowledge_points WHERE knowledge_point_id = $1`,
      [knowledgePointId],
    )
    const row = rows[0]
    if (row === undefined) throw notFound('knowledge point not found')
    if (row.course_id !== courseId || row.chapter_id !== chapterId) {
      throw badRequest('knowledge point does not belong to the given course/chapter')
    }
  }
}

function toSegment(row: SegmentDbRow): AdminSegment {
  return {
    segmentId: row.segment_id,
    courseId: row.course_id,
    chapterId: row.chapter_id,
    knowledgePointId: row.knowledge_point_id,
    title: row.title,
    startSec: row.start_sec,
    endSec: row.end_sec,
    text: row.text,
    status: row.status,
    hasEmbedding: row.has_embedding,
  }
}

function toArticle(row: ArticleRow): AdminArticle {
  if (codePointLength(row.markdown) > MAX_ARTICLE) throw new HttpError(500, 'stored article invalid')
  return {
    markdown: row.markdown,
    version: row.version,
    status: row.status,
    publishedAt: row.published_at?.getTime() ?? null,
  }
}

function toQuiz(row: QuizRow): AdminQuiz {
  const questions = parseQuizQuestions(row.questions, 500)
  if (!Number.isInteger(row.version) || row.version < 1) {
    throw new HttpError(500, 'stored chapter quiz invalid')
  }
  return {
    version: row.version,
    status: row.status,
    publishedAt: row.published_at?.getTime() ?? null,
    questions,
  }
}

function mapDbError(error: unknown, resource: string): never {
  const code = (error as { code?: string }).code
  if (code === '23505') throw conflict(`${resource} already exists`)
  throw error
}
