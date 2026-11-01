import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
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
const ADMIN_DIR = join(process.cwd(), 'dist', 'admin')
const hasAdminBuild = existsSync(join(ADMIN_DIR, 'index.html'))

const pool = createPool(DATABASE_URL)
let app: FastifyInstance | undefined

before(async () => {
  if (!hasAdminBuild) return
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

test('SPA 深链回落到 index.html', { skip: !hasAdminBuild && 'dist/admin 尚未构建' }, async () => {
  assert.ok(app !== undefined)
  const response = await app.inject({
    method: 'GET',
    url: '/admin/courses',
    headers: { accept: 'text/html,application/xhtml+xml' },
  })
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'] ?? '', /text\/html/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.match(response.body, /<div id="root">/)
})

test('API 404 保持 JSON', { skip: !hasAdminBuild && 'dist/admin 尚未构建' }, async () => {
  assert.ok(app !== undefined)
  const response = await app.inject({
    method: 'GET',
    url: '/v1/does-not-exist',
    headers: { accept: 'application/json' },
  })
  assert.equal(response.statusCode, 404)
  assert.match(response.headers['content-type'] ?? '', /application\/json/)
  assert.equal(response.json().error, 'not found')
})

test('哈希静态资源长缓存', { skip: !hasAdminBuild && 'dist/admin 尚未构建' }, async () => {
  assert.ok(app !== undefined)
  const assets = await readdir(join(ADMIN_DIR, 'assets')).catch(() => [] as string[])
  const script = assets.find(name => name.endsWith('.js'))
  assert.ok(script !== undefined, '构建产物中应包含 JS bundle')
  const response = await app.inject({ method: 'GET', url: `/admin/assets/${script}` })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable')
})

test('浏览器请求非后台路径仍为 404', { skip: !hasAdminBuild && 'dist/admin 尚未构建' }, async () => {
  assert.ok(app !== undefined)
  const response = await app.inject({
    method: 'GET',
    url: '/adminish/whatever',
    headers: { accept: 'text/html' },
  })
  assert.equal(response.statusCode, 404)
})
