import type { Pool } from 'pg'
import { HttpError } from '../errors.js'
import { codePointLength, stringField } from '../http/validation.js'

const COURSE_ID = /^[A-Za-z0-9._-]{1,64}$/
const KNOWLEDGE_POINT_ID = /^[A-Za-z0-9._-]{1,64}$/
const SEGMENT_ID = /^seg-[A-Za-z0-9._-]+$/
const MAX_COURSES = 50
const MAX_CHAPTERS = 50
const MAX_KNOWLEDGE_POINTS = 1000
const MAX_ARTICLE_CHARS = 20000
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_ADJACENT = 5

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
  knowledgePoints: CatalogKnowledgePoint[]
}

export interface CatalogCourse {
  courseId: string
  title: string
  chapters: CatalogChapter[]
}

export interface KnowledgePointArticle {
  markdown: string
  version: number
  publishedAt: number
}

export interface KnowledgePointDetail {
  knowledgePointId: string
  courseId: string
  chapterId: string
  title: string
  article: KnowledgePointArticle | null
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
  markdown: string | null
  version: number | null
  published_at: Date | null
  segment_id: string | null
}

export function parseCourseId(raw: string): string {
  return stringField({ courseId: raw }, 'courseId', { max: 64, pattern: COURSE_ID })
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
  constructor(private readonly pool: Pool) {}

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
      `SELECT ch.chapter_id, ch.title, ch.position
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
      courseId: parseCourseId(course.course_id),
      title: title(course.title, 'course title'),
      chapters: chapterRows.map(row => ({
        chapterId: row.chapter_id,
        title: title(row.title, 'chapter title'),
        position: row.position,
        knowledgePoints: pointsByChapter.get(row.chapter_id) ?? [],
      })),
    }
    ensureSize(payload)
    return payload
  }

  async getKnowledgePoint(rawId: string): Promise<KnowledgePointDetail> {
    const knowledgePointId = parseKnowledgePointId(rawId)
    const { rows } = await this.pool.query<DetailRow>(
      `SELECT kp.knowledge_point_id, kp.course_id, kp.chapter_id, kp.title,
              a.markdown, a.version, a.published_at,
              s.segment_id
       FROM knowledge_points kp
       JOIN courses c ON c.course_id = kp.course_id AND c.status = 'published'
       LEFT JOIN articles a
         ON a.knowledge_point_id = kp.knowledge_point_id AND a.status = 'published'
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

    const article = toArticle(row)
    const adjacent = await this.adjacentPoints(row.course_id, knowledgePointId)
    const segment = segmentId(row.segment_id)
    const payload: KnowledgePointDetail = {
      knowledgePointId: parseKnowledgePointId(row.knowledge_point_id),
      courseId: parseCourseId(row.course_id),
      chapterId: row.chapter_id,
      title: title(row.title, 'knowledge point title'),
      article,
      ...(segment === undefined ? {} : { segmentId: segment }),
      adjacentKnowledgePoints: adjacent,
    }
    ensureSize(payload)
    return payload
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

function toArticle(row: DetailRow): KnowledgePointArticle | null {
  if (row.markdown === null) return null
  if (row.version === null || row.published_at === null) throw new HttpError(500, 'stored article invalid')
  const length = codePointLength(row.markdown)
  if (length < 1 || length > MAX_ARTICLE_CHARS) throw new HttpError(500, 'stored article invalid')
  if (!Number.isInteger(row.version) || row.version < 1) throw new HttpError(500, 'stored article version invalid')
  return {
    markdown: row.markdown,
    version: row.version,
    publishedAt: row.published_at.getTime(),
  }
}
