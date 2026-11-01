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

test('005 迁移创建模型配置表与唯一默认约束', async () => {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [['llm_configs', 'asr_config']],
  )
  assert.deepEqual(tables.rows.map(row => row.table_name).sort(), ['asr_config', 'llm_configs'])

  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  )
  const names = new Set(indexes.rows.map(row => row.indexname))
  for (const index of ['llm_configs_default_idx', 'llm_configs_purpose_active_idx']) {
    assert.ok(names.has(index), index)
  }

  await pool.query(
    `INSERT INTO llm_configs (config_id, name, provider, base_url, model, purpose, is_default)
     VALUES ('llmc_0000000000000001', 'primary', 'openai', 'https://api.example.com/v1', 'm1', 'content', true)`,
  )
  await rejectsWithCode(
    pool.query(
      `INSERT INTO llm_configs (config_id, name, provider, base_url, model, purpose, is_default)
       VALUES ('llmc_0000000000000002', 'second', 'openai', 'https://api.example.com/v1', 'm2', 'content', true)`,
    ),
    '23505',
  )
  await pool.query(
    `INSERT INTO llm_configs (config_id, name, provider, base_url, model, purpose, is_default)
     VALUES ('llmc_0000000000000003', 'embed', 'openai', 'https://api.example.com/v1', 'e1', 'embedding', true)`,
  )
  await rejectsWithCode(
    pool.query(
      `INSERT INTO llm_configs (config_id, name, provider, base_url, model, purpose)
       VALUES ('llmc_0000000000000004', 'bad', 'openai', 'https://api.example.com/v1', 'x', 'video')`,
    ),
    '23514',
  )

  await pool.query('INSERT INTO asr_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING')
  await rejectsWithCode(
    pool.query('INSERT INTO asr_config (id) VALUES (2)'),
    '23514',
  )
})

test('006 迁移允许 anthropic 协议并拒绝未知协议', async () => {
  await pool.query(
    `INSERT INTO llm_configs (config_id, name, provider, protocol, base_url, model, purpose)
     VALUES ('llmc_0000000000000005', 'anth', 'anthropic', 'anthropic',
             'https://api.anthropic.com', 'm', 'content')`,
  )
  await rejectsWithCode(
    pool.query(
      `INSERT INTO llm_configs (config_id, name, provider, protocol, base_url, model, purpose)
       VALUES ('llmc_0000000000000006', 'bad', 'openai', 'gemini',
               'https://api.example.com', 'm', 'content')`,
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

test('008 迁移创建章节教材与图示表并扩展图片用途', async () => {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [['chapter_articles', 'figures', 'figure_candidates']],
  )
  assert.deepEqual(
    tables.rows.map(row => row.table_name).sort(),
    ['chapter_articles', 'figure_candidates', 'figures'],
  )

  const image = await pool.query<{ image_price_micros: number }>(
    `INSERT INTO llm_configs (config_id, name, provider, base_url, model, purpose)
     VALUES ('llmc_0000000000000007', 'image', 'volcengine',
             'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seedream', 'image')
     RETURNING image_price_micros`,
  )
  assert.equal(image.rows[0]?.image_price_micros, 120000)

  await pool.query(
    `INSERT INTO chapters (course_id, chapter_id, title)
     VALUES ('course-pipeline', 'ch01', '第一章')
     ON CONFLICT (course_id, chapter_id) DO NOTHING`,
  )
  await rejectsWithCode(
    pool.query(
      `INSERT INTO chapter_articles (course_id, chapter_id, markdown)
       VALUES ('course-pipeline', 'ch01', '')`,
    ),
    '23514',
  )
  await pool.query(
    `INSERT INTO chapter_articles (course_id, chapter_id, markdown, status, published_at)
     VALUES ('course-pipeline', 'ch01', '# 章节', 'published', now())`,
  )

  await rejectsWithCode(
    pool.query(
      `INSERT INTO figures (figure_id, course_id, chapter_id, kind, caption)
       VALUES ('fig_m8bad001', 'course-pipeline', 'ch01', 'keyframe', '')`,
    ),
    '23514',
  )
  await pool.query(
    `INSERT INTO figures (figure_id, course_id, chapter_id, kind, caption, status)
     VALUES ('fig_m8test001', 'course-pipeline', 'ch01', 'generated', '示意', 'planned')`,
  )
  await rejectsWithCode(
    pool.query(
      `INSERT INTO figure_candidates (candidate_id, figure_id, rel_path, width, height, bytes)
       VALUES ('cand_m8test001', 'fig_m8test001', 'fig_m8test001/cand_m8test001.jpg', 799, 900, 2048)`,
    ),
    '23514',
  )
  await pool.query(
    `INSERT INTO figure_candidates (candidate_id, figure_id, rel_path, width, height, bytes, status)
     VALUES ('cand_m8test001', 'fig_m8test001', 'fig_m8test001/cand_m8test001.jpg', 1600, 900, 2048, 'ready')`,
  )
  await rejectsWithCode(
    pool.query(
      `UPDATE figures SET status = 'published', published_at = now() WHERE figure_id = 'fig_m8test001'`,
    ),
    '23514',
  )
  await pool.query(
    `UPDATE figures SET selected_candidate_id = 'cand_m8test001',
            status = 'published', published_at = now()
     WHERE figure_id = 'fig_m8test001'`,
  )

  await pool.query(
    `INSERT INTO pipeline_jobs (job_id, asset_id, course_id, kind, stage)
     VALUES ('job_8899aabbccddeeff', 'asset-new', 'course-pipeline', 'illustrate', 'figure_plan')`,
  )
  await rejectsWithCode(
    pool.query(
      `INSERT INTO pipeline_jobs (job_id, asset_id, course_id, kind, stage)
       VALUES ('job_ffeeddccbbaa9988', 'asset-new', 'course-pipeline', 'illustrate', 'figure_render')`,
    ),
    '23505',
  )

  const usage = await pool.query<{ images: number }>(
    `INSERT INTO ai_usage_events (task_key, status) VALUES ('figure.render', 'success')
     RETURNING images`,
  )
  assert.equal(usage.rows[0]?.images, 0)

  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'content_generations'
       AND column_name = ANY($1)`,
    [['chapter_articles', 'figures']],
  )
  assert.deepEqual(columns.rows.map(row => row.column_name).sort(), ['chapter_articles', 'figures'])
})
