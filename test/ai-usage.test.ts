import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { AiRouter } from '../src/ai/routing.js'
import { AiUsageService, type AiRunHandle } from '../src/ai/usage.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { runMigrations } from '../src/migrate.js'
import { ModelConfigService, type LlmConfigDto } from '../src/model-config/service.js'
import { seedDatabase } from '../src/seed.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://trend_coach:trend_coach@127.0.0.1:5432/trend_coach_test'
const ADMIN_USERNAME = 'admin01'
const ADMIN_PASSWORD = 'bootstrap-password-123'

const pool = createPool(DATABASE_URL)
let app: FastifyInstance
let server: Server
let models: ModelConfigService
let usage: AiUsageService
let router: AiRouter
let adminHeaders: Record<string, string>
let primaryConfig: LlmConfigDto
let fallbackConfig: LlmConfigDto
let primaryStatus = 200
let primaryHits = 0
let fallbackHits = 0

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: 'local',
    DATABASE_URL,
    LOG_LEVEL: 'silent',
    METRICS_TOKEN: 'test-metrics-token-1234',
    BOOTSTRAP_ADMIN_USERNAME: ADMIN_USERNAME,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    RATE_LIMIT_AI_PER_MINUTE: '1000',
    RATE_LIMIT_MODEL_CONFIG_PER_MINUTE: '1000',
    RATE_LIMIT_LOGIN_PER_MINUTE: '1000',
    ...overrides,
  }
}

function chatPayload(content: string, input: number, output: number): string {
  return JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: output },
  })
}

function configInput(
  name: string,
  baseUrl: string,
  options: { purpose?: 'content' | 'embedding'; isActive?: boolean } = {},
) {
  return {
    name,
    provider: 'local-test',
    baseUrl,
    model: `${name}-model`,
    purpose: options.purpose ?? 'content' as const,
    apiKey: 'test-api-key',
    inputPriceMicrosPer1k: 1000,
    outputPriceMicrosPer1k: 2000,
    ...(options.isActive === false ? { isActive: false } : {}),
  }
}

async function run(
  taskKey: 'content.outline' | 'content.article',
  system = 'sys',
  user = 'usr',
): Promise<{ answer: string; fallbackUsed: boolean; handle: AiRunHandle }> {
  const handle = await router.startRun(taskKey, 'pipeline', `job-${taskKey}`)
  const completion = await router.completeJson(handle, taskKey, { system, user }, value => {
    const record = value as { answer?: unknown }
    if (typeof record.answer !== 'string') throw new Error('bad answer')
    return { answer: record.answer }
  })
  await router.finishRun(handle, 'succeeded')
  return { answer: completion.value.answer, fallbackUsed: completion.fallbackUsed, handle }
}

before(async () => {
  await runMigrations(pool, { reset: true })
  await seedDatabase(pool)

  server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if ((request.url ?? '').startsWith('/primary/chat/completions')) {
        primaryHits += 1
        if (primaryStatus !== 200) {
          response.writeHead(primaryStatus, { 'content-type': 'application/json' })
          response.end('{"error":{"message":"rate limited"}}')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(chatPayload('{"answer":"primary"}', 10, 5))
        return
      }
      if ((request.url ?? '').startsWith('/fallback/chat/completions')) {
        fallbackHits += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(chatPayload('{"answer":"fallback"}', 7, 3))
        return
      }
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  const config = loadConfig(env())
  models = new ModelConfigService(pool, {
    encryptionKey: config.credentialEncryptionKey,
    asrTimeoutMs: config.asrTimeoutMs,
    llmTuning: config.llmTuning,
  })
  usage = new AiUsageService(pool)
  router = new AiRouter({ pool, models, usage, cooldownMs: 60_000 })

  primaryConfig = await models.createLlm(
    configInput('primary', `http://127.0.0.1:${port}/primary`),
  )
  fallbackConfig = await models.createLlm(
    configInput('fallback', `http://127.0.0.1:${port}/fallback`),
  )

  app = await buildApp({ config, pool, models })
  await app.ready()
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/session',
    payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  })
  assert.equal(login.statusCode, 200, login.body)
  adminHeaders = { authorization: `Bearer ${(login.json() as { token: string }).token}` }
})

after(async () => {
  await app.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await pool.end()
})

test('AI 用量：成功调用记录 token、步骤与价格', async () => {
  await app.inject({
    method: 'PUT',
    url: '/v1/admin/ai/bindings/content.outline',
    headers: adminHeaders,
    payload: { primaryConfigId: primaryConfig.configId },
  })
  const first = await run('content.outline')
  assert.equal(first.answer, 'primary')
  assert.equal(first.fallbackUsed, false)
  assert.equal(primaryHits, 1)

  const summary = await app.inject({
    method: 'GET',
    url: '/v1/admin/ai/usage/summary?task=content.outline',
    headers: adminHeaders,
  })
  assert.equal(summary.statusCode, 200, summary.body)
  const body = summary.json() as {
    totals: {
      requests: number
      errors: number
      fallbacks: number
      inputTokens: number
      outputTokens: number
      costMicros: number | null
    }
    daily: unknown[]
    byTask: { taskKey: string }[]
    byModel: { configId: string; requests: number }[]
  }
  assert.equal(body.totals.requests, 1)
  assert.equal(body.totals.errors, 0)
  assert.equal(body.totals.fallbacks, 0)
  assert.equal(body.totals.inputTokens, 10)
  assert.equal(body.totals.outputTokens, 5)
  assert.equal(body.totals.costMicros, 20)
  assert.equal(body.daily.length, 1)
  assert.equal(body.byTask[0]?.taskKey, 'content.outline')
  assert.equal(body.byModel[0]?.configId, primaryConfig.configId)
  assert.equal(body.byModel[0]?.requests, 1)

  const runDetail = await app.inject({
    method: 'GET',
    url: `/v1/admin/ai/runs/${first.handle.runId}`,
    headers: adminHeaders,
  })
  assert.equal(runDetail.statusCode, 200, runDetail.body)
  const detail = runDetail.json() as {
    status: string
    fallbackUsed: boolean
    source: string
    durationMs: number | null
    steps: { seq: number; status: string; attempt: number; inputTokens?: number }[]
  }
  assert.equal(detail.status, 'succeeded')
  assert.equal(detail.fallbackUsed, false)
  assert.equal(detail.source, 'pipeline')
  assert.equal(typeof detail.durationMs, 'number')
  assert.ok((detail.durationMs ?? -1) >= 0)
  assert.equal(detail.steps.length, 1)
  assert.equal(detail.steps[0]?.seq, 1)
  assert.equal(detail.steps[0]?.attempt, 1)
})

test('AI 路由：主模型 429 切备用、健康冷却与冷却期跳过', async () => {
  await app.inject({
    method: 'PUT',
    url: '/v1/admin/ai/bindings/content.article',
    headers: adminHeaders,
    payload: {
      primaryConfigId: primaryConfig.configId,
      fallbackConfigId: fallbackConfig.configId,
    },
  })
  primaryStatus = 429
  const failedOver = await run('content.article')
  assert.equal(failedOver.answer, 'fallback')
  assert.equal(failedOver.fallbackUsed, true)
  assert.equal(primaryHits, 2)
  assert.equal(fallbackHits, 1)

  const { rows } = await pool.query<{ status: string; error_code: string | null }>(
    'SELECT status, error_code FROM ai_usage_events WHERE run_id = $1 ORDER BY usage_id',
    [failedOver.handle.runId],
  )
  assert.deepEqual(rows.map(row => row.status), ['error', 'fallback'])
  assert.equal(rows[0]?.error_code, 'rate_limited')

  const steps = await pool.query<{ seq: number; attempt: number; status: string }>(
    'SELECT seq, attempt, status FROM ai_run_steps WHERE run_id = $1 ORDER BY seq',
    [failedOver.handle.runId],
  )
  assert.deepEqual(steps.rows.map(row => [row.seq, row.attempt, row.status]), [
    [1, 1, 'error'],
    [2, 2, 'success'],
  ])

  const health = await app.inject({ method: 'GET', url: '/v1/admin/ai/health', headers: adminHeaders })
  assert.equal(health.statusCode, 200, health.body)
  const primaryHealth = (health.json() as {
    configs: { configId: string; coolingDown: boolean; consecutiveFailures: number; lastError: string | null }[]
  }).configs.find(config => config.configId === primaryConfig.configId)
  assert.equal(primaryHealth?.coolingDown, true)
  assert.equal(primaryHealth?.consecutiveFailures, 1)
  assert.equal(primaryHealth?.lastError, 'rate_limited')

  // 冷却期内主模型被跳过，请求不会再打到 /primary。
  const skipped = await run('content.article')
  assert.equal(skipped.answer, 'fallback')
  assert.equal(skipped.fallbackUsed, false)
  assert.equal(primaryHits, 2)
  assert.equal(fallbackHits, 2)
})

test('AI 路由：冷却到期后主模型恢复并清零健康计数', async () => {
  await pool.query(
    `UPDATE llm_config_health SET cooldown_until = now() - interval '1 second'
     WHERE config_id = $1`,
    [primaryConfig.configId],
  )
  primaryStatus = 200
  const fresh = new AiRouter({ pool, models, usage, cooldownMs: 60_000 })
  const handle = await fresh.startRun('content.article', 'pipeline', 'job-recover')
  const completion = await fresh.completeJson(handle, 'content.article', { system: 's', user: 'u' }, value => value)
  await fresh.finishRun(handle, 'succeeded')
  assert.deepEqual(completion.value, { answer: 'primary' })
  assert.equal(primaryHits, 3)

  const { rows } = await pool.query<{
    consecutive_failures: number
    cooldown_until: Date | null
    last_error: string | null
    last_success_at: Date | null
  }>(
    'SELECT consecutive_failures, cooldown_until, last_error, last_success_at FROM llm_config_health WHERE config_id = $1',
    [primaryConfig.configId],
  )
  assert.equal(rows[0]?.consecutive_failures, 0)
  assert.equal(rows[0]?.cooldown_until, null)
  assert.equal(rows[0]?.last_error, null)
  assert.ok(rows[0]?.last_success_at instanceof Date)
})

test('AI 用量：汇总、明细与运行列表口径一致', async () => {
  const summary = await app.inject({
    method: 'GET',
    url: '/v1/admin/ai/usage/summary?task=content.article',
    headers: adminHeaders,
  })
  assert.equal(summary.statusCode, 200, summary.body)
  const body = summary.json() as {
    totals: {
      requests: number
      errors: number
      fallbacks: number
      inputTokens: number
      outputTokens: number
      costMicros: number | null
    }
    byModel: { configId: string; requests: number; errors: number }[]
  }
  assert.equal(body.totals.requests, 4)
  assert.equal(body.totals.errors, 1)
  assert.equal(body.totals.fallbacks, 1)
  assert.equal(body.totals.inputTokens, 24)
  assert.equal(body.totals.outputTokens, 11)
  assert.equal(body.totals.costMicros, 46)
  assert.equal(body.byModel.length, 2)

  const events = await app.inject({
    method: 'GET',
    url: '/v1/admin/ai/usage/events?task=content.article&limit=200',
    headers: adminHeaders,
  })
  assert.equal(events.statusCode, 200, events.body)
  const eventBody = events.json() as {
    events: { status: string; attempt?: number; inputTokens: number }[]
    nextCursor: string | null
  }
  assert.equal(eventBody.events.length, 4)
  assert.equal(eventBody.nextCursor, null)
  assert.equal(eventBody.events[0]?.status, 'success')
  assert.equal(eventBody.events[3]?.status, 'error')

  const runs = await app.inject({
    method: 'GET',
    url: '/v1/admin/ai/runs?task=content.article&limit=200',
    headers: adminHeaders,
  })
  assert.equal(runs.statusCode, 200, runs.body)
  const runBody = runs.json() as {
    runs: { runId: string; status: string; fallbackUsed: boolean; steps?: unknown[] }[]
    nextCursor: string | null
  }
  assert.equal(runBody.runs.length, 3)
  assert.equal(runBody.nextCursor, null)
  const fallbackRun = runBody.runs.find(entry => entry.fallbackUsed)
  assert.equal(fallbackRun?.status, 'succeeded')

  const detail = await app.inject({
    method: 'GET',
    url: `/v1/admin/ai/runs/${fallbackRun?.runId ?? ''}`,
    headers: adminHeaders,
  })
  assert.equal(detail.statusCode, 200, detail.body)
  const steps = (detail.json() as { steps: { usageId: string | null; errorCode: string | null }[] }).steps
  assert.equal(steps.length, 2)
  assert.ok(steps.every(step => step.usageId !== null))
  assert.equal(steps[0]?.errorCode, 'rate_limited')
  assert.equal(steps[1]?.errorCode, null)

  const badRange = await app.inject({
    method: 'GET',
    url: '/v1/admin/ai/usage/summary?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
    headers: adminHeaders,
  })
  assert.equal(badRange.statusCode, 400)
})

test('任务绑定：purpose 校验、禁用配置与运营只读', async () => {
  const bindings = await app.inject({
    method: 'GET',
    url: '/v1/admin/ai/bindings',
    headers: adminHeaders,
  })
  assert.equal(bindings.statusCode, 200, bindings.body)
  const body = bindings.json() as {
    bindings: { taskKey: string; purpose: string; primaryConfigId: string | null; fallbackConfigId: string | null }[]
    configs: { configId: string }[]
  }
  assert.equal(body.bindings.length, 5)
  const article = body.bindings.find(binding => binding.taskKey === 'content.article')
  assert.equal(article?.primaryConfigId, primaryConfig.configId)
  assert.equal(article?.fallbackConfigId, fallbackConfig.configId)
  assert.equal(article?.purpose, 'content')

  const created = await app.inject({
    method: 'PUT',
    url: '/v1/admin/ai/bindings/content.points',
    headers: adminHeaders,
    payload: { primaryConfigId: primaryConfig.configId, fallbackConfigId: fallbackConfig.configId },
  })
  assert.equal(created.statusCode, 200, created.body)

  const sameFallback = await app.inject({
    method: 'PUT',
    url: '/v1/admin/ai/bindings/content.points',
    headers: adminHeaders,
    payload: { primaryConfigId: primaryConfig.configId, fallbackConfigId: primaryConfig.configId },
  })
  assert.equal(sameFallback.statusCode, 400)

  const wrongPurpose = await app.inject({
    method: 'PUT',
    url: '/v1/admin/ai/bindings/embedding.query',
    headers: adminHeaders,
    payload: { primaryConfigId: primaryConfig.configId },
  })
  assert.equal(wrongPurpose.statusCode, 400)

  const disabled = await models.createLlm(
    configInput('disabled', primaryConfig.baseUrl, { isActive: false }),
  )
  const disabledBinding = await app.inject({
    method: 'PUT',
    url: '/v1/admin/ai/bindings/content.points',
    headers: adminHeaders,
    payload: { primaryConfigId: disabled.configId },
  })
  assert.equal(disabledBinding.statusCode, 409)

  const cleared = await app.inject({
    method: 'PUT',
    url: '/v1/admin/ai/bindings/content.points',
    headers: adminHeaders,
    payload: { primaryConfigId: null },
  })
  assert.equal(cleared.statusCode, 200, cleared.body)
  assert.equal((cleared.json() as { primaryConfigId: string | null }).primaryConfigId, null)

  const operator = await app.inject({
    method: 'POST',
    url: '/v1/admin/users',
    headers: adminHeaders,
    payload: {
      username: 'ai-operator-01',
      displayName: 'AI 运营',
      role: 'operator',
      password: 'operator-password-123',
    },
  })
  assert.equal(operator.statusCode, 201, operator.body)
  const operatorLogin = await app.inject({
    method: 'POST',
    url: '/v1/auth/session',
    payload: { username: 'ai-operator-01', password: 'operator-password-123' },
  })
  assert.equal(operatorLogin.statusCode, 200, operatorLogin.body)
  const operatorHeaders = {
    authorization: `Bearer ${(operatorLogin.json() as { token: string }).token}`,
  }
  const read = await app.inject({
    method: 'GET',
    url: '/v1/admin/ai/usage/summary',
    headers: operatorHeaders,
  })
  assert.equal(read.statusCode, 200, read.body)
  const write = await app.inject({
    method: 'PUT',
    url: '/v1/admin/ai/bindings/content.points',
    headers: operatorHeaders,
    payload: { primaryConfigId: primaryConfig.configId },
  })
  assert.equal(write.statusCode, 403)
})
