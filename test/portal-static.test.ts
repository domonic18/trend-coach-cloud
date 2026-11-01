import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { runMigrations } from '../src/migrate.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://trend_coach:trend_coach@127.0.0.1:5432/trend_coach_test'
const METRICS_TOKEN = 'test-metrics-token-1234'
const PORTAL_DIR = join(process.cwd(), 'dist', 'portal')
const hasPortalBuild = existsSync(join(PORTAL_DIR, 'index.html'))
const HAS_BUILD = 'dist/portal 尚未构建'

const pool = createPool(DATABASE_URL)
let app: FastifyInstance | undefined

before(async () => {
  if (!hasPortalBuild) return
  await runMigrations(pool, { reset: true })
  app = await buildApp({
    config: loadConfig({
      APP_ENV: 'local',
      DATABASE_URL,
      LOG_LEVEL: 'silent',
      METRICS_TOKEN,
    }),
    pool,
  })
  await app.ready()
})

after(async () => {
  await app?.close()
  await pool.end()
})

async function html(url: string): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
  assert.ok(app !== undefined)
  const response = await app.inject({
    method: 'GET',
    url,
    headers: { accept: 'text/html,application/xhtml+xml' },
  })
  return { statusCode: response.statusCode, body: response.body, headers: response.headers }
}

test('门户首页与预渲染标题', { skip: !hasPortalBuild && HAS_BUILD }, async () => {
  const response = await html('/')
  assert.equal(response.statusCode, 200)
  assert.match(String(response.headers['content-type']), /text\/html/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.match(response.body, /<title>趋势交易课程伴学｜把课程与 AI 问答装进本地客户端<\/title>/)
  assert.match(response.body, /rel="canonical" href="[^"]+\/"/)
  assert.match(response.body, /<meta property="og:title"/)
  // 预渲染内容必须包含真实页面结构，而不是空壳。
  assert.match(response.body, /<div id="root"><div/)
})

test('深链命中预渲染页面且忽略尾斜杠', { skip: !hasPortalBuild && HAS_BUILD }, async () => {
  const guide = await html('/guide')
  assert.equal(guide.statusCode, 200)
  assert.match(guide.body, /<title>使用向导｜安装 dsh 与学习插件<\/title>/)
  assert.equal(guide.headers['cache-control'], 'no-store')

  const trailing = await html('/system/')
  assert.equal(trailing.statusCode, 200)
  assert.match(trailing.body, /<title>趋势交易体系｜理念、方法框架与风险控制<\/title>/)

  const legal = await html('/legal/privacy')
  assert.equal(legal.statusCode, 200)
  assert.match(legal.body, /<title>隐私说明｜趋势交易课程伴学<\/title>/)
})

test('需要登录的页面标记 noindex', { skip: !hasPortalBuild && HAS_BUILD }, async () => {
  const login = await html('/login')
  assert.equal(login.statusCode, 200)
  assert.match(login.body, /<meta name="robots" content="noindex,nofollow" \/>/)
  assert.equal(login.headers['x-robots-tag'], undefined)
})

test('未知前端路径回落空壳且禁止索引', { skip: !hasPortalBuild && HAS_BUILD }, async () => {
  const response = await html('/does-not-exist')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['x-robots-tag'], 'noindex')
  assert.match(response.body, /<div id="root"><\/div>/)
})

test('未知 API 路径保持 JSON 404', { skip: !hasPortalBuild && HAS_BUILD }, async () => {
  const response = await html('/v1/does-not-exist')
  assert.equal(response.statusCode, 404)
  assert.match(String(response.headers['content-type']), /application\/json/)
  assert.equal(JSON.parse(response.body).error, 'not found')
})

test('sitemap 与 robots 走公开缓存且排除 noindex 页面', { skip: !hasPortalBuild && HAS_BUILD }, async () => {
  const sitemap = await html('/sitemap.xml')
  assert.equal(sitemap.statusCode, 200)
  assert.equal(sitemap.headers['cache-control'], 'public, max-age=3600')
  assert.match(sitemap.body, /\/guide<\/loc>/)
  assert.match(sitemap.body, /\/legal\/privacy<\/loc>/)
  assert.doesNotMatch(sitemap.body, /\/login<\/loc>/)
  assert.doesNotMatch(sitemap.body, /\/account<\/loc>/)

  const robots = await html('/robots.txt')
  assert.equal(robots.statusCode, 200)
  assert.match(robots.body, /Disallow: \/v1\//)
  assert.match(robots.body, /Sitemap: .+\/sitemap\.xml/)
})

test('哈希静态资源长缓存', { skip: !hasPortalBuild && HAS_BUILD }, async () => {
  const assets = await readdir(join(PORTAL_DIR, 'assets')).catch(() => [] as string[])
  const script = assets.find(name => name.endsWith('.js'))
  assert.ok(script !== undefined, '构建产物中应包含 JS bundle')
  const response = await app!.inject({ method: 'GET', url: `/assets/${script}` })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable')
})

test('发布包下载带附件头', { skip: !hasPortalBuild && HAS_BUILD }, async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'content', 'releases.json'), 'utf8')) as {
    plugin: { fileName: string } | null
  }
  const fileName = manifest.plugin?.fileName
  if (fileName === undefined || !existsSync(join(process.cwd(), 'dist', 'downloads', fileName))) return
  const response = await app!.inject({ method: 'GET', url: `/downloads/${fileName}` })
  assert.equal(response.statusCode, 200)
  assert.match(String(response.headers['content-disposition']), /^attachment;/)
})
