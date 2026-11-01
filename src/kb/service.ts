import type { Pool } from 'pg'
import type { AppConfig } from '../config.js'
import { badRequest, HttpError } from '../errors.js'
import { codePointLength, intField, optionalStringField, stringField, asObject } from '../http/validation.js'
import { toVectorLiteral, type EmbeddingResolver } from './embedding.js'

const SEGMENT_ID = /^seg-[A-Za-z0-9._-]+$/
const COURSE_ID = /^[A-Za-z0-9._-]{1,64}$/
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_RELATED_POINTS = 5
const RECALL_FACTOR = 4
const MIN_RECALL_WINDOW = 20
const VECTOR_MIN_COSINE = 0.2

export interface SearchInput {
  query: string
  topK: number
  courseId?: string
}

export interface SegmentOut {
  segmentId: string
  courseId: string
  chapterId: string
  knowledgePointId: string
  title: string
  courseTitle: string
  chapterTitle: string
  knowledgePointTitle: string
  startSec: number
  endSec: number
  text: string
  score: number
}

export interface RelatedPoint {
  knowledgePointId: string
  title: string
}

export interface SearchResult {
  segments: SegmentOut[]
  relatedKnowledgePoints: RelatedPoint[]
}

export interface SegmentRow {
  segment_id: string
  course_id: string
  chapter_id: string
  knowledge_point_id: string
  title: string
  course_title: string
  chapter_title: string
  knowledge_point_title: string
  start_sec: number
  end_sec: number
  text: string
  score: number | string
}

export interface Candidate {
  row: SegmentRow
  score: number
}

export function parseSearchBody(body: unknown): SearchInput {
  const object = asObject(body)
  const rawQuery = object.query
  if (typeof rawQuery !== 'string') throw badRequest('query must be a string')
  const query = rawQuery.trim()
  const length = codePointLength(query)
  if (length < 1 || length > 500) throw badRequest('query must be 1–500 characters after trimming')
  const topK = intField(object, 'topK', { min: 1, max: 20, fallback: 5 })
  const courseId = optionalStringField(object, 'courseId', { max: 64, pattern: COURSE_ID })
  return { query, topK, ...(courseId === undefined ? {} : { courseId }) }
}

export function parseSegmentId(raw: string): string {
  return stringField({ segmentId: raw }, 'segmentId', { max: 80, pattern: SEGMENT_ID })
}

/** RRF 融合：同片段按名次累加，除以单列表理论最高分后归一到 [0,1]。 */
export function fuse(lists: Candidate[][], k: number): Map<string, { row: SegmentRow; score: number }> {
  const active = lists.filter(list => list.length > 0)
  const merged = new Map<string, { row: SegmentRow; score: number }>()
  if (active.length === 0) return merged
  const maxScore = active.length / (k + 1)
  for (const list of active) {
    list.forEach((candidate, index) => {
      const contribution = 1 / (k + index + 1)
      const existing = merged.get(candidate.row.segment_id)
      if (existing === undefined) {
        merged.set(candidate.row.segment_id, { row: candidate.row, score: contribution })
      } else {
        existing.score += contribution
      }
    })
  }
  for (const entry of merged.values()) entry.score = Math.min(1, entry.score / maxScore)
  return merged
}

export class KnowledgeService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly embedding?: EmbeddingResolver,
  ) {}

  async search(input: SearchInput): Promise<SearchResult> {
    const window = Math.max(input.topK * RECALL_FACTOR, MIN_RECALL_WINDOW)
    const lexical = await this.lexicalRecall(input, window)
    const embed = await this.embedding?.resolve()
    const vector = embed === undefined ? [] : await this.vectorRecall(embed, input, window)
    // 召回阈值只负责捞候选，引用置信阈值负责过滤单个 trigram 级别的偶然命中。
    const confident = [lexical, vector].map(list =>
      list.filter(candidate => candidate.score >= this.config.searchMinConfidence),
    )
    const fused = fuse(confident, this.config.rrfK)
    const segments = [...fused.values()]
      .sort((a, b) => b.score - a.score || a.row.segment_id.localeCompare(b.row.segment_id))
      .slice(0, input.topK)
      .map(entry => toSegment(entry.row, entry.score))
    const relatedKnowledgePoints = segments.length === 0
      ? await this.relatedPoints(input.query, input.courseId)
      : []
    const payload: SearchResult = { segments, relatedKnowledgePoints }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_RESPONSE_BYTES) {
      throw new HttpError(500, 'response exceeds 512KiB')
    }
    return payload
  }

  private async lexicalRecall(input: SearchInput, limit: number): Promise<Candidate[]> {
    const { rows } = await this.pool.query<SegmentRow>(
      `SELECT s.segment_id, s.course_id, s.chapter_id, s.knowledge_point_id, s.title,
              s.start_sec, s.end_sec, s.text,
              c.title AS course_title, ch.title AS chapter_title, kp.title AS knowledge_point_title,
              GREATEST(similarity(s.title, $1), similarity(s.text, $1), word_similarity($1, s.text)) AS score
       FROM segments s
       JOIN courses c ON c.course_id = s.course_id
       JOIN chapters ch ON ch.course_id = s.course_id AND ch.chapter_id = s.chapter_id
       JOIN knowledge_points kp ON kp.knowledge_point_id = s.knowledge_point_id
       WHERE s.status = 'published' AND c.status = 'published'
         AND ($2::text IS NULL OR s.course_id = $2)
         AND GREATEST(similarity(s.title, $1), similarity(s.text, $1), word_similarity($1, s.text)) >= $3
       ORDER BY score DESC, s.segment_id
       LIMIT $4`,
      [input.query, input.courseId ?? null, this.config.searchMinSimilarity, limit],
    )
    return rows.map(row => ({ row, score: Number(row.score) }))
  }

  private async vectorRecall(
    embed: (text: string) => Promise<number[]>,
    input: SearchInput,
    limit: number,
  ): Promise<Candidate[]> {
    const vector = toVectorLiteral(await embed(input.query))
    const { rows } = await this.pool.query<SegmentRow>(
      `SELECT s.segment_id, s.course_id, s.chapter_id, s.knowledge_point_id, s.title,
              s.start_sec, s.end_sec, s.text,
              c.title AS course_title, ch.title AS chapter_title, kp.title AS knowledge_point_title,
              1 - (s.embedding <=> $1::halfvec) AS score
       FROM segments s
       JOIN courses c ON c.course_id = s.course_id
       JOIN chapters ch ON ch.course_id = s.course_id AND ch.chapter_id = s.chapter_id
       JOIN knowledge_points kp ON kp.knowledge_point_id = s.knowledge_point_id
       WHERE s.status = 'published' AND c.status = 'published'
         AND s.embedding IS NOT NULL
         AND ($2::text IS NULL OR s.course_id = $2)
         AND 1 - (s.embedding <=> $1::halfvec) >= $4
       ORDER BY s.embedding <=> $1::halfvec, s.segment_id
       LIMIT $3`,
      [vector, input.courseId ?? null, limit, VECTOR_MIN_COSINE],
    )
    return rows.map(row => ({ row, score: Number(row.score) }))
  }

  private async relatedPoints(query: string, courseId: string | undefined): Promise<RelatedPoint[]> {
    const { rows } = await this.pool.query<{ knowledge_point_id: string; title: string }>(
      `SELECT kp.knowledge_point_id, kp.title
       FROM knowledge_points kp
       JOIN courses c ON c.course_id = kp.course_id
       WHERE c.status = 'published'
         AND ($2::text IS NULL OR kp.course_id = $2)
         AND GREATEST(similarity(kp.title, $1), word_similarity($1, kp.title)) >= $3
       ORDER BY GREATEST(similarity(kp.title, $1), word_similarity($1, kp.title)) DESC, kp.knowledge_point_id
       LIMIT $4`,
      [query, courseId ?? null, this.config.searchMinConfidence, MAX_RELATED_POINTS],
    )
    return rows.map(row => ({ knowledgePointId: row.knowledge_point_id, title: row.title }))
  }

  async getSegment(rawId: string): Promise<SegmentOut> {
    const segmentId = parseSegmentId(rawId)
    const { rows } = await this.pool.query<SegmentRow>(
      `SELECT s.segment_id, s.course_id, s.chapter_id, s.knowledge_point_id, s.title,
              s.start_sec, s.end_sec, s.text,
              c.title AS course_title, ch.title AS chapter_title, kp.title AS knowledge_point_title,
              1 AS score
       FROM segments s
       JOIN courses c ON c.course_id = s.course_id
       JOIN chapters ch ON ch.course_id = s.course_id AND ch.chapter_id = s.chapter_id
       JOIN knowledge_points kp ON kp.knowledge_point_id = s.knowledge_point_id
       WHERE s.segment_id = $1 AND s.status = 'published' AND c.status = 'published'`,
      [segmentId],
    )
    const row = rows[0]
    if (row === undefined) throw new HttpError(404, 'segment not found')
    return toSegment(row, 1)
  }
}

/** 存量数据损坏时整体失败，不把越界内容下发给插件。 */
function toSegment(row: SegmentRow, score: number): SegmentOut {
  if (!SEGMENT_ID.test(row.segment_id) || codePointLength(row.segment_id) > 80) {
    throw new HttpError(500, 'stored segment id invalid')
  }
  if (codePointLength(row.title) < 1 || codePointLength(row.title) > 200) {
    throw new HttpError(500, 'stored segment title invalid')
  }
  if (codePointLength(row.text) < 1 || codePointLength(row.text) > 4000) {
    throw new HttpError(500, 'stored segment text invalid')
  }
  if (!Number.isInteger(row.start_sec) || !Number.isInteger(row.end_sec) || row.start_sec >= row.end_sec) {
    throw new HttpError(500, 'stored segment time range invalid')
  }
  return {
    segmentId: row.segment_id,
    courseId: row.course_id,
    chapterId: row.chapter_id,
    knowledgePointId: row.knowledge_point_id,
    title: row.title,
    courseTitle: row.course_title,
    chapterTitle: row.chapter_title,
    knowledgePointTitle: row.knowledge_point_title,
    startSec: row.start_sec,
    endSec: row.end_sec,
    text: row.text,
    score: Number(Math.min(1, Math.max(0, score)).toFixed(4)),
  }
}
