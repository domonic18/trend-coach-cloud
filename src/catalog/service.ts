import type { Pool } from 'pg'
import { parseQuizQuestions, type QuizQuestion } from '../content/quiz.js'
import { HttpError } from '../errors.js'
import { codePointLength, stringField } from '../http/validation.js'

const COURSE_ID = /^[A-Za-z0-9._-]{1,64}$/
const CHAPTER_ID = /^[A-Za-z0-9._-]{1,64}$/
const KNOWLEDGE_POINT_ID = /^[A-Za-z0-9._-]{1,64}$/
const SEGMENT_ID = /^seg-[A-Za-z0-9._-]+$/
const FIGURE_ID = /^fig_[A-Za-z0-9._-]{1,60}$/
const FIGURE_REF = /!\[[^\]\n]*\]\(figure:([A-Za-z0-9._-]{1,64})\)/g
const MAX_COURSES = 50
const MAX_CHAPTERS = 50
const MAX_KNOWLEDGE_POINTS = 1000
const MAX_CHAPTER_MARKDOWN_CHARS = 20000
const MAX_FIGURES_PER_CHAPTER = 3
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_ADJACENT = 5

/** M8 起课程树携带契约版本；缺失视为 1，避免旧云端被静默降级。 */
export const CATALOG_CONTRACT_VERSION = 2

export interface CatalogCourseSummary {
  courseId: string
  title: string
  chapterCount: number
  knowledgePointCount: number
  completedCount: number
}

export interface CatalogKnowledgePoint {
  knowledgePointId: string
  title: string
  position: number
  segmentId?: string
  watchedSec: number
  completed: boolean
}

export interface CatalogChapter {
  chapterId: string
  title: string
  position: number
  hasArticle: boolean
  figureCount: number
  knowledgePoints: CatalogKnowledgePoint[]
}

export interface CatalogCourse {
  contractVersion: number
  courseId: string
  title: string
  chapters: CatalogChapter[]
}

export interface ChapterArticle {
  markdown: string
  version: number
  publishedAt: number
}

export interface ChapterFigure {
  url: string
  width: number
  height: number
  alt: string
  caption?: string
}

export interface ChapterQuiz {
  version: number
  publishedAt: number
  questions: QuizQuestion[]
}

export interface CatalogChapterArticle {
  chapterId: string
  courseId: string
  title: string
  article: ChapterArticle | null
  figures: Record<string, ChapterFigure>
  adjacentChapters: { chapterId: string; title: string }[]
  quiz: ChapterQuiz | null
}

export interface KnowledgePointDetail {
  knowledgePointId: string
  courseId: string
  chapterId: string
  title: string
  segmentId?: string
  adjacentKnowledgePoints: { knowledgePointId: string; title: string }[]
}

interface CourseRow {
  course_id: string
  title: string
  chapter_count: number
  knowledge_point_count: number
  completed_count: number
}

interface ChapterRow {
  chapter_id: string
  title: string
  position: number
  has_article: boolean
  figure_count: number
}

interface PointRow {
  chapter_id: string
  knowledge_point_id: string
  title: string
  position: number
  segment_id: string | null
  watched_sec: number
  completed: boolean
}

interface DetailRow {
  knowledge_point_id: string
  course_id: string
  chapter_id: string
  title: string
  segment_id: string | null
}

interface ChapterArticleRow {
  markdown: string | null
  version: number | null
  published_at: Date | null
}

interface ChapterFigureRow {
  figure_id: string
  caption: string
  width: number
  height: number
  rel_path: string
}

interface ChapterQuizRow {
  questions: unknown
  version: number
  published_at: Date | null
}

export function parseCourseId(raw: string): string {
  return stringField({ courseId: raw }, 'courseId', { max: 64, pattern: COURSE_ID })
}

export function parseChapterId(raw: string): string {
  return stringField({ chapterId: raw }, 'chapterId', { max: 64, pattern: CHAPTER_ID })
}

export function parseKnowledgePointId(raw: string): string {
  return stringField({ knowledgePointId: raw }, 'knowledgePointId', { max: 64, pattern: KNOWLEDGE_POINT_ID })
}

function title(value: string, field: string): string {
  const length = codePointLength(value)
  if (length < 1 || length > 200) throw new HttpError(500, `stored ${field} invalid`)
  return value
}

function segmentId(value: string | null): string | undefined {
  if (value === null) return undefined
  if (!SEGMENT_ID.test(value) || codePointLength(value) > 80) throw new HttpError(500, 'stored segment id invalid')
  return value
}

function ensureSize(payload: unknown): void {
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_RESPONSE_BYTES) {
    throw new HttpError(500, 'response exceeds 512KiB')
  }
}

export class CatalogService {
  constructor(
    private readonly pool: Pool,
    private readonly figureUrl: (relPath: string) => string,
  ) {}

  async listCourses(userId: string): Promise<{ courses: CatalogCourseSummary[] }> {
    const { rows } = await this.pool.query<CourseRow>(
      `SELECT c.course_id, c.title,
              (SELECT count(*)::int FROM chapters ch WHERE ch.course_id = c.course_id) AS chapter_count,
              (SELECT count(*)::int FROM knowledge_points kp WHERE kp.course_id = c.course_id) AS knowledge_point_count,
              COALESCE((
                SELECT count(*)::int
                FROM learning_progress lp
                JOIN knowledge_points kp ON kp.knowledge_point_id = lp.knowledge_point_id
                WHERE lp.user_id = $1 AND lp.completed AND kp.course_id = c.course_id
              ), 0) AS completed_count
       FROM courses c
       WHERE c.status = 'published'
       ORDER BY c.course_id
       LIMIT $2`,
      [userId, MAX_COURSES + 1],
    )
    if (rows.length > MAX_COURSES) throw new HttpError(500, 'too many courses')
    const courses = rows.map(row => ({
      courseId: parseCourseId(row.course_id),
      title: title(row.title, 'course title'),
      chapterCount: row.chapter_count,
      knowledgePointCount: row.knowledge_point_count,
      completedCount: row.completed_count,
    }))
    const payload = { courses }
    ensureSize(payload)
    return payload
  }

  async getCourse(rawCourseId: string, userId: string): Promise<CatalogCourse> {
    const courseId = parseCourseId(rawCourseId)
    const { rows: courseRows } = await this.pool.query<{ course_id: string; title: string }>(
      `SELECT course_id, title FROM courses WHERE course_id = $1 AND status = 'published'`,
      [courseId],
    )
    const course = courseRows[0]
    if (course === undefined) throw new HttpError(404, 'course not found')

    const { rows: chapterRows } = await this.pool.query<ChapterRow>(
      `SELECT ch.chapter_id, ch.title, ch.position,
              EXISTS(
                SELECT 1 FROM chapter_articles ca
                WHERE ca.course_id = ch.course_id AND ca.chapter_id = ch.chapter_id
                  AND ca.status = 'published'
              ) AS has_article,
              (SELECT count(*)::int FROM figures f
               WHERE f.course_id = ch.course_id AND f.chapter_id = ch.chapter_id
                 AND f.status = 'published') AS figure_count
       FROM chapters ch
       JOIN courses c ON c.course_id = ch.course_id
       WHERE ch.course_id = $1 AND c.status = 'published'
       ORDER BY ch.position, ch.chapter_id
       LIMIT $2`,
      [courseId, MAX_CHAPTERS + 1],
    )
    if (chapterRows.length > MAX_CHAPTERS) throw new HttpError(500, 'too many chapters')

    const { rows: pointRows } = await this.pool.query<PointRow>(
      `SELECT kp.chapter_id, kp.knowledge_point_id, kp.title, kp.position,
              s.segment_id,
              COALESCE(lp.watched_sec, 0) AS watched_sec,
              COALESCE(lp.completed, false) AS completed
       FROM knowledge_points kp
       LEFT JOIN LATERAL (
         SELECT sg.segment_id
         FROM segments sg
         WHERE sg.knowledge_point_id = kp.knowledge_point_id AND sg.status = 'published'
         ORDER BY sg.start_sec, sg.segment_id
         LIMIT 1
       ) s ON true
       LEFT JOIN learning_progress lp
         ON lp.user_id = $2 AND lp.knowledge_point_id = kp.knowledge_point_id
       WHERE kp.course_id = $1
       ORDER BY kp.position, kp.knowledge_point_id
       LIMIT $3`,
      [courseId, userId, MAX_KNOWLEDGE_POINTS + 1],
    )
    if (pointRows.length > MAX_KNOWLEDGE_POINTS) throw new HttpError(500, 'too many knowledge points')

    const pointsByChapter = new Map<string, CatalogKnowledgePoint[]>()
    for (const row of pointRows) {
      const segment = segmentId(row.segment_id)
      const point: CatalogKnowledgePoint = {
        knowledgePointId: parseKnowledgePointId(row.knowledge_point_id),
        title: title(row.title, 'knowledge point title'),
        position: row.position,
        ...(segment === undefined ? {} : { segmentId: segment }),
        watchedSec: row.watched_sec,
        completed: row.completed,
      }
      const list = pointsByChapter.get(row.chapter_id) ?? []
      list.push(point)
      pointsByChapter.set(row.chapter_id, list)
    }

    const payload: CatalogCourse = {
      contractVersion: CATALOG_CONTRACT_VERSION,
      courseId: parseCourseId(course.course_id),
      title: title(course.title, 'course title'),
      chapters: chapterRows.map(row => ({
        chapterId: row.chapter_id,
        title: title(row.title, 'chapter title'),
        position: row.position,
        hasArticle: row.has_article,
        figureCount: row.figure_count,
        knowledgePoints: pointsByChapter.get(row.chapter_id) ?? [],
      })),
    }
    ensureSize(payload)
    return payload
  }

  async getChapter(rawCourseId: string, rawChapterId: string): Promise<CatalogChapterArticle> {
    const courseId = parseCourseId(rawCourseId)
    const chapterId = parseChapterId(rawChapterId)
    const { rows } = await this.pool.query<{ chapter_id: string; course_id: string; title: string }>(
      `SELECT ch.chapter_id, ch.course_id, ch.title
       FROM chapters ch
       JOIN courses c ON c.course_id = ch.course_id AND c.status = 'published'
       WHERE ch.course_id = $1 AND ch.chapter_id = $2`,
      [courseId, chapterId],
    )
    const chapter = rows[0]
    if (chapter === undefined) throw new HttpError(404, 'chapter not found')

    const article = await this.chapterArticle(courseId, chapterId)
    const figures = await this.chapterFigures(courseId, chapterId)
    if (article !== null) ensureFigureRefs(article.markdown, figures)
    const adjacentChapters = await this.adjacentChapters(courseId, chapterId)
    const quiz = await this.chapterQuiz(courseId, chapterId)
    const payload: CatalogChapterArticle = {
      chapterId: chapter.chapter_id,
      courseId: parseCourseId(chapter.course_id),
      title: title(chapter.title, 'chapter title'),
      article,
      figures,
      adjacentChapters,
      quiz,
    }
    ensureSize(payload)
    return payload
  }

  async getKnowledgePoint(rawId: string): Promise<KnowledgePointDetail> {
    const knowledgePointId = parseKnowledgePointId(rawId)
    const { rows } = await this.pool.query<DetailRow>(
      `SELECT kp.knowledge_point_id, kp.course_id, kp.chapter_id, kp.title, s.segment_id
       FROM knowledge_points kp
       JOIN courses c ON c.course_id = kp.course_id AND c.status = 'published'
       LEFT JOIN LATERAL (
         SELECT sg.segment_id
         FROM segments sg
         WHERE sg.knowledge_point_id = kp.knowledge_point_id AND sg.status = 'published'
         ORDER BY sg.start_sec, sg.segment_id
         LIMIT 1
       ) s ON true
       WHERE kp.knowledge_point_id = $1`,
      [knowledgePointId],
    )
    const row = rows[0]
    if (row === undefined) throw new HttpError(404, 'knowledge point not found')

    const adjacent = await this.adjacentPoints(row.course_id, knowledgePointId)
    const segment = segmentId(row.segment_id)
    const payload: KnowledgePointDetail = {
      knowledgePointId: parseKnowledgePointId(row.knowledge_point_id),
      courseId: parseCourseId(row.course_id),
      chapterId: row.chapter_id,
      title: title(row.title, 'knowledge point title'),
      ...(segment === undefined ? {} : { segmentId: segment }),
      adjacentKnowledgePoints: adjacent,
    }
    ensureSize(payload)
    return payload
  }

  private async chapterArticle(courseId: string, chapterId: string): Promise<ChapterArticle | null> {
    const { rows } = await this.pool.query<ChapterArticleRow>(
      `SELECT markdown, version, published_at
       FROM chapter_articles
       WHERE course_id = $1 AND chapter_id = $2 AND status = 'published'`,
      [courseId, chapterId],
    )
    const row = rows[0]
    if (row === undefined || row.markdown === null) return null
    if (row.version === null || row.published_at === null) throw new HttpError(500, 'stored chapter article invalid')
    const length = codePointLength(row.markdown)
    if (length < 1 || length > MAX_CHAPTER_MARKDOWN_CHARS) {
      throw new HttpError(500, 'stored chapter article invalid')
    }
    if (!Number.isInteger(row.version) || row.version < 1) {
      throw new HttpError(500, 'stored chapter article version invalid')
    }
    return { markdown: row.markdown, version: row.version, publishedAt: row.published_at.getTime() }
  }

  private async chapterQuiz(courseId: string, chapterId: string): Promise<ChapterQuiz | null> {
    const { rows } = await this.pool.query<ChapterQuizRow>(
      `SELECT questions, version, published_at
       FROM chapter_quizzes
       WHERE course_id = $1 AND chapter_id = $2 AND status = 'published'`,
      [courseId, chapterId],
    )
    const row = rows[0]
    if (row === undefined) return null
    if (!Number.isInteger(row.version) || row.version < 1 || row.published_at === null) {
      throw new HttpError(500, 'stored chapter quiz invalid')
    }
    const questions = parseQuizQuestions(row.questions, 500)
    return { version: row.version, publishedAt: row.published_at.getTime(), questions }
  }

  private async chapterFigures(courseId: string, chapterId: string): Promise<Record<string, ChapterFigure>> {
    const { rows } = await this.pool.query<ChapterFigureRow>(
      `SELECT f.figure_id, f.caption, c.width, c.height, c.rel_path
       FROM figures f
       JOIN figure_candidates c ON c.candidate_id = f.selected_candidate_id AND c.status = 'ready'
       WHERE f.course_id = $1 AND f.chapter_id = $2 AND f.status = 'published'
       ORDER BY f.created_at, f.figure_id
       LIMIT $3`,
      [courseId, chapterId, MAX_FIGURES_PER_CHAPTER + 1],
    )
    if (rows.length > MAX_FIGURES_PER_CHAPTER) throw new HttpError(500, 'too many figures in chapter')

    const figures: Record<string, ChapterFigure> = {}
    for (const row of rows) {
      if (!FIGURE_ID.test(row.figure_id)) throw new HttpError(500, 'stored figure id invalid')
      const caption = title(row.caption, 'figure caption')
      if (!Number.isInteger(row.width) || row.width < 800 || row.width > 20000
        || !Number.isInteger(row.height) || row.height < 800 || row.height > 20000) {
        throw new HttpError(500, 'stored figure size invalid')
      }
      if (!row.rel_path.startsWith(`${row.figure_id}/`)) {
        throw new HttpError(500, 'stored figure path mismatch')
      }
      figures[row.figure_id] = {
        url: this.figureUrl(row.rel_path),
        width: row.width,
        height: row.height,
        alt: caption,
        caption,
      }
    }
    return figures
  }

  private async adjacentChapters(
    courseId: string,
    chapterId: string,
  ): Promise<{ chapterId: string; title: string }[]> {
    const { rows } = await this.pool.query<{ chapter_id: string; title: string }>(
      `WITH ordered AS (
         SELECT ch.chapter_id, ch.title,
                row_number() OVER (ORDER BY ch.position, ch.chapter_id) AS rn
         FROM chapters ch
         JOIN courses c ON c.course_id = ch.course_id AND c.status = 'published'
         WHERE ch.course_id = $1
       ), target AS (
         SELECT rn FROM ordered WHERE chapter_id = $2
       )
       SELECT o.chapter_id, o.title
       FROM ordered o, target t
       WHERE o.chapter_id <> $2
         AND o.rn BETWEEN t.rn - 2 AND t.rn + 3
       ORDER BY abs(o.rn - t.rn), o.rn
       LIMIT $3`,
      [courseId, chapterId, MAX_ADJACENT],
    )
    return rows.map(row => ({
      chapterId: row.chapter_id,
      title: title(row.title, 'chapter title'),
    }))
  }

  private async adjacentPoints(
    courseId: string,
    knowledgePointId: string,
  ): Promise<{ knowledgePointId: string; title: string }[]> {
    const { rows } = await this.pool.query<{ knowledge_point_id: string; title: string }>(
      `WITH ordered AS (
         SELECT kp.knowledge_point_id, kp.title,
                row_number() OVER (ORDER BY kp.position, kp.knowledge_point_id) AS rn
         FROM knowledge_points kp
         JOIN courses c ON c.course_id = kp.course_id AND c.status = 'published'
         WHERE kp.course_id = $1
       ), target AS (
         SELECT rn FROM ordered WHERE knowledge_point_id = $2
       )
       SELECT o.knowledge_point_id, o.title
       FROM ordered o, target t
       WHERE o.knowledge_point_id <> $2
         AND o.rn BETWEEN t.rn - 2 AND t.rn + 3
       ORDER BY abs(o.rn - t.rn), o.rn
       LIMIT $3`,
      [courseId, knowledgePointId, MAX_ADJACENT],
    )
    return rows.map(row => ({
      knowledgePointId: parseKnowledgePointId(row.knowledge_point_id),
      title: title(row.title, 'knowledge point title'),
    }))
  }
}

/** 发布校验之外的兜底：正文引用了未下发图示属于数据损坏，不静默忽略。 */
function ensureFigureRefs(markdown: string, figures: Record<string, ChapterFigure>): void {
  for (const match of markdown.matchAll(FIGURE_REF)) {
    const figureId = match[1]
    if (figureId === undefined || !(figureId in figures)) {
      throw new HttpError(500, 'stored chapter article has unresolved figure')
    }
  }
}
