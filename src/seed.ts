import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { withTransaction } from './db.js'

export interface SeedSegment {
  segmentId: string
  courseId: string
  chapterId: string
  knowledgePointId: string
  title: string
  startSec: number
  endSec: number
  text: string
}

export interface SeedChapterArticle {
  courseId: string
  chapterId: string
  markdown: string
  version: number
  publishedAt: string
}

export interface Seed {
  courses: { courseId: string; title: string }[]
  chapters: { courseId: string; chapterId: string; title: string; position: number }[]
  knowledgePoints: { knowledgePointId: string; courseId: string; chapterId: string; title: string; position: number }[]
  segments: SeedSegment[]
  mediaAssets: { assetId: string; courseId: string; hlsPath: string; encryption: string }[]
  chapterArticles?: SeedChapterArticle[]
}

export const DEFAULT_SEED_PATH = fileURLToPath(new URL('../data/seed.json', import.meta.url))

export async function seedDatabase(pool: Pool, seedPath = DEFAULT_SEED_PATH): Promise<Seed> {
  const seed = JSON.parse(await readFile(seedPath, 'utf8')) as Seed
  await withTransaction(pool, async client => {
    for (const course of seed.courses) {
      await client.query(
        `INSERT INTO courses (course_id, title, status) VALUES ($1, $2, 'published')
         ON CONFLICT (course_id) DO UPDATE SET title = EXCLUDED.title, status = 'published'`,
        [course.courseId, course.title],
      )
    }
    for (const chapter of seed.chapters) {
      await client.query(
        `INSERT INTO chapters (course_id, chapter_id, title, position) VALUES ($1, $2, $3, $4)
         ON CONFLICT (course_id, chapter_id) DO UPDATE SET title = EXCLUDED.title, position = EXCLUDED.position`,
        [chapter.courseId, chapter.chapterId, chapter.title, chapter.position],
      )
    }
    for (const point of seed.knowledgePoints) {
      await client.query(
        `INSERT INTO knowledge_points (knowledge_point_id, course_id, chapter_id, title, position)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (knowledge_point_id) DO UPDATE
         SET course_id = EXCLUDED.course_id, chapter_id = EXCLUDED.chapter_id,
             title = EXCLUDED.title, position = EXCLUDED.position`,
        [point.knowledgePointId, point.courseId, point.chapterId, point.title, point.position],
      )
    }
    for (const segment of seed.segments) {
      await client.query(
        `INSERT INTO segments (segment_id, course_id, chapter_id, knowledge_point_id, title, start_sec, end_sec, text, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'published')
         ON CONFLICT (segment_id) DO UPDATE
         SET course_id = EXCLUDED.course_id, chapter_id = EXCLUDED.chapter_id,
             knowledge_point_id = EXCLUDED.knowledge_point_id, title = EXCLUDED.title,
             start_sec = EXCLUDED.start_sec, end_sec = EXCLUDED.end_sec,
             text = EXCLUDED.text, status = 'published', updated_at = now()`,
        [
          segment.segmentId, segment.courseId, segment.chapterId, segment.knowledgePointId,
          segment.title, segment.startSec, segment.endSec, segment.text,
        ],
      )
    }
    for (const article of seed.chapterArticles ?? []) {
      await client.query(
        `INSERT INTO chapter_articles (course_id, chapter_id, markdown, version, status, published_at, updated_at)
         VALUES ($1, $2, $3, $4, 'published', $5, now())
         ON CONFLICT (course_id, chapter_id) DO UPDATE
         SET markdown = EXCLUDED.markdown, version = EXCLUDED.version,
             status = 'published', published_at = EXCLUDED.published_at, updated_at = now()`,
        [article.courseId, article.chapterId, article.markdown, article.version, new Date(article.publishedAt)],
      )
    }
    for (const asset of seed.mediaAssets) {
      await client.query(
        `INSERT INTO media_assets (asset_id, course_id, hls_path, encryption) VALUES ($1, $2, $3, $4)
         ON CONFLICT (asset_id) DO UPDATE
         SET course_id = EXCLUDED.course_id, hls_path = EXCLUDED.hls_path, encryption = EXCLUDED.encryption`,
        [asset.assetId, asset.courseId, asset.hlsPath, asset.encryption],
      )
    }
  })
  return seed
}
