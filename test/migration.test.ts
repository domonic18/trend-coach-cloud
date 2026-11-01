import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createPool } from '../src/db.js'
import { runMigrations } from '../src/migrate.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://trend_coach:trend_coach@127.0.0.1:5432/trend_coach_test'
const pool = createPool(DATABASE_URL)

const TABLES = [
  'content_generations',
  'media_transcripts',
  'pipeline_jobs',
  'transcript_chunks',
  'transcript_segments',
]

const INDEXES = [
  'content_generations_active_idx',
  'media_assets_course_status_idx',
  'pipeline_jobs_active_idx',
  'pipeline_jobs_asset_idx',
  'pipeline_jobs_claim_idx',
  'transcript_segments_start_idx',
]

before(async () => {
  await runMigrations(pool, { reset: true })
})

after(async () => {
  await pool.end()
})

async function rejectsWithCode(query: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(query, (error: unknown) => (error as { code?: string }).code === code)
}

test('004 迁移创建管线表、列与索引', async () => {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [TABLES],
  )
  assert.deepEqual(tables.rows.map(row => row.table_name).sort(), [...TABLES].sort())

  const columns = await pool.query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'media_assets'`,
  )
  const nullable = new Map(columns.rows.map(row => [row.column_name, row.is_nullable]))
  assert.equal(nullable.get('hls_path'), 'YES')
  for (const column of ['title', 'status', 'source_rel_path', 'source_size_bytes', 'source_sha256', 'duration_ms', 'error_code', 'updated_at']) {
    assert.ok(nullable.has(column), column)
  }

  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  )
  const names = new Set(indexes.rows.map(row => row.indexname))
  for (const index of INDEXES) assert.ok(names.has(index), index)
})

test('存量素材保持 ready，新素材可无 hls_path', async () => {
  await pool.query(
    `INSERT INTO courses (course_id, title, status) VALUES ('course-pipeline', '管线', 'draft')`,
  )
  const legacy = await pool.query<{ status: string }>(
    `INSERT INTO media_assets (asset_id, course_id, hls_path)
     VALUES ('asset-legacy', 'course-pipeline', 'hls/legacy/index.m3u8')
     RETURNING status`,
  )
  assert.equal(legacy.rows[0]?.status, 'ready')

  const pending = await pool.query<{ hls_path: string | null }>(
    `INSERT INTO media_assets (asset_id, course_id, status)
     VALUES ('asset-new', 'course-pipeline', 'awaiting_upload')
     RETURNING hls_path`,
  )
  assert.equal(pending.rows[0]?.hls_path, null)

  await rejectsWithCode(
    pool.query(
      `INSERT INTO media_assets (asset_id, course_id, status)
       VALUES ('asset-bad', 'course-pipeline', 'unknown')`,
    ),
    '23514',
  )
})

test('pipeline_jobs 校验 ID、状态与同素材活跃任务唯一', async () => {
  await rejectsWithCode(
    pool.query(
      `INSERT INTO pipeline_jobs (job_id, asset_id, course_id, kind)
       VALUES ('job_bad', 'asset-new', 'course-pipeline', 'ingest')`,
    ),
    '23514',
  )

  await pool.query(
    `INSERT INTO pipeline_jobs (job_id, asset_id, course_id, kind)
     VALUES ('job_0123456789abcdef', 'asset-new', 'course-pipeline', 'ingest')`,
  )
  await rejectsWithCode(
    pool.query(
      `INSERT INTO pipeline_jobs (job_id, asset_id, course_id, kind)
       VALUES ('job_fedcba9876543210', 'asset-new', 'course-pipeline', 'ingest')`,
    ),
    '23505',
  )

  await pool.query(
    `UPDATE pipeline_jobs SET status = 'succeeded', finished_at = now()
     WHERE job_id = 'job_0123456789abcdef'`,
  )
  await pool.query(
    `INSERT INTO pipeline_jobs (job_id, asset_id, course_id, kind)
     VALUES ('job_fedcba9876543210', 'asset-new', 'course-pipeline', 'ingest')`,
  )

  await rejectsWithCode(
    pool.query(
      `INSERT INTO pipeline_jobs (job_id, asset_id, course_id, kind, stage)
       VALUES ('job_0011223344556677', 'asset-new', 'course-pipeline', 'generate', 'unknown')`,
    ),
    '23514',
  )
})

test('转写块拒绝非正时间范围', async () => {
  await pool.query(
    `INSERT INTO media_transcripts (transcript_id, asset_id, model)
     VALUES ('tr_0123456789abcdef', 'asset-new', 'asr-1.0')`,
  )
  await rejectsWithCode(
    pool.query(
      `INSERT INTO transcript_chunks (chunk_id, transcript_id, idx, start_ms, end_ms)
       VALUES ('chunk_0123456789abcdef', 'tr_0123456789abcdef', 0, 1000, 1000)`,
    ),
    '23514',
  )
  await pool.query(
    `INSERT INTO transcript_chunks (chunk_id, transcript_id, idx, start_ms, end_ms)
     VALUES ('chunk_0123456789abcdef', 'tr_0123456789abcdef', 0, 1000, 2000)`,
  )
  await rejectsWithCode(
    pool.query(
      `INSERT INTO transcript_chunks (chunk_id, transcript_id, idx, start_ms, end_ms)
       VALUES ('chunk_fedcba9876543210', 'tr_0123456789abcdef', 0, 3000, 4000)`,
    ),
    '23505',
  )
})
