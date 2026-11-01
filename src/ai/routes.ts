import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { AccountService } from '../accounts/service.js'
import type { AppConfig } from '../config.js'
import { badRequest, conflict, notFound, tooManyRequests } from '../errors.js'
import { requireSession } from '../http/principal.js'
import { asObject } from '../http/validation.js'
import type { ModelConfigService } from '../model-config/service.js'
import type { RateLimiter } from '../rate-limit.js'
import {
  LLM_TASKS,
  TASK_LABELS,
  isAiTaskKey,
  isLlmTaskKey,
  taskPurpose,
  type AiTaskKey,
  type LlmTaskKey,
} from './tasks.js'

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CONFIG_ID = /^llmc_[0-9a-f]{16}$/
const CURSOR = /^\d+$/
const RUN_CURSOR = /^(\d+):([0-9a-f-]{36})$/
const DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000
const RUN_STATUSES = ['running', 'succeeded', 'failed'] as const
const RUN_SOURCES = ['pipeline', 'admin'] as const

export interface AiRouteDeps {
  pool: Pool
  models: ModelConfigService
  accounts: AccountService
  config: AppConfig
  limiter: RateLimiter
}

function number(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value !== '') return Number(value)
  return 0
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

function queryString(query: unknown, key: string): string | undefined {
  const value = (query as Record<string, unknown> | undefined)?.[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw badRequest(`${key} must be a string`)
  return value
}

function range(query: unknown): { from: Date; to: Date } {
  const toRaw = queryString(query, 'to')
  const to = toRaw === undefined ? new Date() : new Date(Date.parse(toRaw))
  if (Number.isNaN(to.getTime())) throw badRequest('to must be an ISO date')
  const fromRaw = queryString(query, 'from')
  const from = fromRaw === undefined
    ? new Date(to.getTime() - DEFAULT_RANGE_MS)
    : new Date(Date.parse(fromRaw))
  if (Number.isNaN(from.getTime())) throw badRequest('from must be an ISO date')
  if (from.getTime() > to.getTime()) throw badRequest('from must be earlier than to')
  return { from, to }
}

function optionalTask(query: unknown): AiTaskKey | undefined {
  const raw = queryString(query, 'task')
  if (raw === undefined) return undefined
  if (!isAiTaskKey(raw)) throw badRequest('task invalid')
  return raw
}

function optionalStatus(query: unknown): (typeof RUN_STATUSES)[number] | undefined {
  const raw = queryString(query, 'status')
  if (raw === undefined) return undefined
  if (!(RUN_STATUSES as readonly string[]).includes(raw)) throw badRequest('status invalid')
  return raw as (typeof RUN_STATUSES)[number]
}

function optionalSource(query: unknown): (typeof RUN_SOURCES)[number] | undefined {
  const raw = queryString(query, 'source')
  if (raw === undefined) return undefined
  if (!(RUN_SOURCES as readonly string[]).includes(raw)) throw badRequest('source invalid')
  return raw as (typeof RUN_SOURCES)[number]
}

function limit(query: unknown): number {
  const raw = queryString(query, 'limit')
  if (raw === undefined) return 50
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 200) throw badRequest('limit must be 1–200')
  return value
}

function taskKeyParam(raw: string): LlmTaskKey {
  if (!isLlmTaskKey(raw)) throw badRequest('taskKey invalid')
  return raw
}

const COST_MICROS = `round((u.input_tokens * c.input_price_micros_per_1k + u.output_tokens * c.output_price_micros_per_1k) / 1000.0)`
const UNPRICED = `count(*) FILTER (WHERE (u.input_tokens > 0 OR u.output_tokens > 0)
  AND (c.input_price_micros_per_1k IS NULL OR c.output_price_micros_per_1k IS NULL)) > 0`
const COST_SELECT = `CASE WHEN ${UNPRICED} THEN NULL ELSE COALESCE(sum(${COST_MICROS}), 0)::bigint END AS cost_micros`

export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const { pool, models, accounts, config, limiter } = deps

  const readGuard = async (request: FastifyRequest): Promise<void> => {
    const principal = await requireSession(request, accounts, ['operator', 'admin'])
    if (!limiter.take(`ai:${principal.userId}`, config.rateLimitAiPerMinute)) {
      throw tooManyRequests()
    }
  }
  const writeGuard = async (request: FastifyRequest): Promise<void> => {
    const principal = await requireSession(request, accounts, ['admin'])
    if (!limiter.take(`ai-write:${principal.userId}`, config.rateLimitAiPerMinute)) {
      throw tooManyRequests()
    }
  }

  app.get('/v1/admin/ai/usage/summary', async request => {
    await readGuard(request)
    const { from, to } = range(request.query)
    const task = optionalTask(request.query)
    const filters = task === undefined
      ? { where: 'u.created_at >= $1 AND u.created_at < $2', params: [from, to] }
      : { where: 'u.created_at >= $1 AND u.created_at < $2 AND u.task_key = $3', params: [from, to, task] }

    const [totals, daily, byTask, byModel] = await Promise.all([
      pool.query<{
        requests: number
        errors: number
        fallbacks: number
        input_tokens: string
        output_tokens: string
        cached_tokens: string
        audio_seconds: number
        characters: string
        avg_latency_ms: number | null
        cost_micros: string | null
      }>(
        `SELECT count(*)::int AS requests,
                count(*) FILTER (WHERE u.status = 'error')::int AS errors,
                count(*) FILTER (WHERE u.status = 'fallback')::int AS fallbacks,
                COALESCE(sum(u.input_tokens), 0)::bigint AS input_tokens,
                COALESCE(sum(u.output_tokens), 0)::bigint AS output_tokens,
                COALESCE(sum(u.cached_tokens), 0)::bigint AS cached_tokens,
                COALESCE(sum(u.audio_seconds), 0)::float8 AS audio_seconds,
                COALESCE(sum(u.characters), 0)::bigint AS characters,
                round(avg(u.latency_ms))::int AS avg_latency_ms,
                ${COST_SELECT}
         FROM ai_usage_events u
         LEFT JOIN llm_configs c ON c.config_id = u.config_id
         WHERE ${filters.where}`,
        filters.params,
      ),
      pool.query<{ day: string; requests: number; input_tokens: string; output_tokens: string; cost_micros: string | null }>(
        `SELECT to_char(date_trunc('day', u.created_at), 'YYYY-MM-DD') AS day,
                count(*)::int AS requests,
                COALESCE(sum(u.input_tokens), 0)::bigint AS input_tokens,
                COALESCE(sum(u.output_tokens), 0)::bigint AS output_tokens,
                ${COST_SELECT}
         FROM ai_usage_events u
         LEFT JOIN llm_configs c ON c.config_id = u.config_id
         WHERE ${filters.where}
         GROUP BY 1 ORDER BY 1`,
        filters.params,
      ),
      pool.query<{
        task_key: string
        requests: number
        errors: number
        input_tokens: string
        output_tokens: string
        audio_seconds: number
        characters: string
        cost_micros: string | null
      }>(
        `SELECT u.task_key,
                count(*)::int AS requests,
                count(*) FILTER (WHERE u.status = 'error')::int AS errors,
                COALESCE(sum(u.input_tokens), 0)::bigint AS input_tokens,
                COALESCE(sum(u.output_tokens), 0)::bigint AS output_tokens,
                COALESCE(sum(u.audio_seconds), 0)::float8 AS audio_seconds,
                COALESCE(sum(u.characters), 0)::bigint AS characters,
                ${COST_SELECT}
         FROM ai_usage_events u
         LEFT JOIN llm_configs c ON c.config_id = u.config_id
         WHERE ${filters.where}
         GROUP BY u.task_key ORDER BY requests DESC, u.task_key`,
        filters.params,
      ),
      pool.query<{
        config_id: string | null
        provider: string | null
        model: string | null
        requests: number
        errors: number
        input_tokens: string
        output_tokens: string
        cost_micros: string | null
      }>(
        `SELECT u.config_id, u.provider, u.model,
                count(*)::int AS requests,
                count(*) FILTER (WHERE u.status = 'error')::int AS errors,
                COALESCE(sum(u.input_tokens), 0)::bigint AS input_tokens,
                COALESCE(sum(u.output_tokens), 0)::bigint AS output_tokens,
                ${COST_SELECT}
         FROM ai_usage_events u
         LEFT JOIN llm_configs c ON c.config_id = u.config_id
         WHERE ${filters.where}
         GROUP BY u.config_id, u.provider, u.model
         ORDER BY requests DESC, u.model`,
        filters.params,
      ),
    ])

    const total = totals.rows[0]
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        requests: total?.requests ?? 0,
        errors: total?.errors ?? 0,
        fallbacks: total?.fallbacks ?? 0,
        inputTokens: number(total?.input_tokens),
        outputTokens: number(total?.output_tokens),
        cachedTokens: number(total?.cached_tokens),
        audioSeconds: number(total?.audio_seconds),
        characters: number(total?.characters),
        avgLatencyMs: total?.avg_latency_ms ?? 0,
        costMicros: total === undefined || total.cost_micros === null
          ? null
          : number(total.cost_micros),
      },
      daily: daily.rows.map(row => ({
        date: row.day,
        requests: row.requests,
        inputTokens: number(row.input_tokens),
        outputTokens: number(row.output_tokens),
        costMicros: row.cost_micros === null ? null : number(row.cost_micros),
      })),
      byTask: byTask.rows.map(row => ({
        taskKey: row.task_key,
        label: TASK_LABELS[row.task_key as AiTaskKey] ?? row.task_key,
        requests: row.requests,
        errors: row.errors,
        inputTokens: number(row.input_tokens),
        outputTokens: number(row.output_tokens),
        audioSeconds: number(row.audio_seconds),
        characters: number(row.characters),
        costMicros: row.cost_micros === null ? null : number(row.cost_micros),
      })),
      byModel: byModel.rows.map(row => ({
        configId: row.config_id,
        provider: row.provider,
        model: row.model,
        requests: row.requests,
        errors: row.errors,
        inputTokens: number(row.input_tokens),
        outputTokens: number(row.output_tokens),
        costMicros: row.cost_micros === null ? null : number(row.cost_micros),
      })),
    }
  })

  app.get('/v1/admin/ai/usage/events', async request => {
    await readGuard(request)
    const { from, to } = range(request.query)
    const task = optionalTask(request.query)
    const model = queryString(request.query, 'model')
    const rawCursor = queryString(request.query, 'cursor')
    if (rawCursor !== undefined && !CURSOR.test(rawCursor)) throw badRequest('cursor invalid')
    const take = limit(request.query)

    const params: unknown[] = [from, to]
    const where = ['u.created_at >= $1', 'u.created_at < $2']
    if (task !== undefined) {
      params.push(task)
      where.push(`u.task_key = $${params.length}`)
    }
    if (model !== undefined) {
      params.push(model)
      where.push(`u.model = $${params.length}`)
    }
    if (rawCursor !== undefined) {
      params.push(rawCursor)
      where.push(`u.usage_id < $${params.length}::bigint`)
    }
    params.push(take)
    const { rows } = await pool.query<{
      usage_id: string
      run_id: string | null
      task_key: string
      provider: string | null
      model: string | null
      config_id: string | null
      input_tokens: number
      output_tokens: number
      cached_tokens: number
      audio_seconds: string
      characters: number
      latency_ms: number
      status: string
      error_code: string | null
      created_at: Date
    }>(
      `SELECT usage_id::text AS usage_id, run_id, task_key, provider, model, config_id,
              input_tokens, output_tokens, cached_tokens, audio_seconds,
              characters, latency_ms, status, error_code, created_at
       FROM ai_usage_events u
       WHERE ${where.join(' AND ')}
       ORDER BY u.usage_id DESC
       LIMIT $${params.length}`,
      params,
    )
    const last = rows[rows.length - 1]
    return {
      events: rows.map(row => ({
        usageId: row.usage_id,
        runId: row.run_id,
        taskKey: row.task_key,
        label: TASK_LABELS[row.task_key as AiTaskKey] ?? row.task_key,
        provider: row.provider,
        model: row.model,
        configId: row.config_id,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cachedTokens: row.cached_tokens,
        audioSeconds: number(row.audio_seconds),
        characters: row.characters,
        latencyMs: row.latency_ms,
        status: row.status,
        errorCode: row.error_code,
        createdAt: row.created_at.toISOString(),
      })),
      nextCursor: rows.length === take && last !== undefined ? last.usage_id : null,
    }
  })

  app.get('/v1/admin/ai/runs', async request => {
    await readGuard(request)
    const { from, to } = range(request.query)
    const task = optionalTask(request.query)
    const status = optionalStatus(request.query)
    const source = optionalSource(request.query)
    const rawCursor = queryString(request.query, 'cursor')
    const cursor = rawCursor === undefined ? null : RUN_CURSOR.exec(rawCursor)
    if (rawCursor !== undefined && cursor === null) throw badRequest('cursor invalid')
    const take = limit(request.query)

    const params: unknown[] = [from, to]
    const where = ['r.started_at >= $1', 'r.started_at < $2']
    if (task !== undefined) {
      params.push(task)
      where.push(`r.task_key = $${params.length}`)
    }
    if (status !== undefined) {
      params.push(status)
      where.push(`r.status = $${params.length}`)
    }
    if (source !== undefined) {
      params.push(source)
      where.push(`r.source = $${params.length}`)
    }
    if (cursor !== null) {
      params.push(new Date(Number(cursor[1])), cursor[2]!)
      where.push(`(r.started_at, r.run_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`)
    }
    params.push(take)
    const { rows } = await pool.query<{
      run_id: string
      task_key: string
      source: string
      source_id: string | null
      status: string
      primary_config_id: string | null
      fallback_used: boolean
      started_at: Date
      finished_at: Date | null
      error_code: string | null
    }>(
      `SELECT r.run_id, r.task_key, r.source, r.source_id, r.status, r.primary_config_id,
              r.fallback_used, r.started_at, r.finished_at, r.error_code
       FROM ai_runs r
       WHERE ${where.join(' AND ')}
       ORDER BY r.started_at DESC, r.run_id DESC
       LIMIT $${params.length}`,
      params,
    )
    const last = rows[rows.length - 1]
    return {
      runs: rows.map(row => ({
        runId: row.run_id,
        taskKey: row.task_key,
        label: TASK_LABELS[row.task_key as AiTaskKey] ?? row.task_key,
        source: row.source,
        sourceId: row.source_id,
        status: row.status,
        primaryConfigId: row.primary_config_id,
        fallbackUsed: row.fallback_used,
        startedAt: row.started_at.toISOString(),
        finishedAt: iso(row.finished_at),
        durationMs: row.finished_at === null ? null : row.finished_at.getTime() - row.started_at.getTime(),
        errorCode: row.error_code,
      })),
      nextCursor: rows.length === take && last !== undefined
        ? `${last.started_at.getTime()}:${last.run_id}`
        : null,
    }
  })

  app.get<{ Params: { runId: string } }>('/v1/admin/ai/runs/:runId', async request => {
    await readGuard(request)
    const runId = request.params.runId
    if (!RUN_ID.test(runId)) throw badRequest('runId invalid')
    const { rows } = await pool.query<{
      run_id: string
      task_key: string
      source: string
      source_id: string | null
      status: string
      primary_config_id: string | null
      fallback_used: boolean
      started_at: Date
      finished_at: Date | null
      error_code: string | null
      summary: unknown
    }>(
      `SELECT run_id, task_key, source, source_id, status, primary_config_id, fallback_used,
              started_at, finished_at, error_code, summary
       FROM ai_runs WHERE run_id = $1`,
      [runId],
    )
    const run = rows[0]
    if (run === undefined) throw notFound('run not found')
    const steps = await pool.query<{
      step_id: string
      seq: number
      task_key: string
      config_id: string | null
      provider: string | null
      model: string | null
      attempt: number
      status: string
      latency_ms: number
      usage_id: string | null
      error_code: string | null
      created_at: Date
    }>(
      `SELECT step_id::text AS step_id, seq, task_key, config_id, provider, model, attempt,
              status, latency_ms, usage_id::text AS usage_id, error_code, created_at
       FROM ai_run_steps WHERE run_id = $1 ORDER BY seq`,
      [runId],
    )
    return {
      runId: run.run_id,
      taskKey: run.task_key,
      label: TASK_LABELS[run.task_key as AiTaskKey] ?? run.task_key,
      source: run.source,
      sourceId: run.source_id,
      status: run.status,
      primaryConfigId: run.primary_config_id,
      fallbackUsed: run.fallback_used,
      startedAt: run.started_at.toISOString(),
      finishedAt: iso(run.finished_at),
      durationMs: run.finished_at === null ? null : run.finished_at.getTime() - run.started_at.getTime(),
      errorCode: run.error_code,
      summary: run.summary,
      steps: steps.rows.map(step => ({
        stepId: step.step_id,
        seq: step.seq,
        taskKey: step.task_key,
        configId: step.config_id,
        provider: step.provider,
        model: step.model,
        attempt: step.attempt,
        status: step.status,
        latencyMs: step.latency_ms,
        usageId: step.usage_id,
        errorCode: step.error_code,
        createdAt: step.created_at.toISOString(),
      })),
    }
  })

  app.get('/v1/admin/ai/bindings', async request => {
    await readGuard(request)
    const [{ rows }, configs] = await Promise.all([
      pool.query<{
        task_key: string
        primary_config_id: string
        fallback_config_id: string | null
        updated_at: Date
      }>('SELECT task_key, primary_config_id, fallback_config_id, updated_at FROM llm_task_bindings'),
      models.listLlm(),
    ])
    const byTask = new Map(rows.map(row => [row.task_key, row]))
    return {
      bindings: LLM_TASKS.map(taskKey => {
        const row = byTask.get(taskKey)
        return {
          taskKey,
          label: TASK_LABELS[taskKey],
          purpose: taskPurpose(taskKey),
          primaryConfigId: row?.primary_config_id ?? null,
          fallbackConfigId: row?.fallback_config_id ?? null,
          updatedAt: row === undefined ? null : row.updated_at.toISOString(),
        }
      }),
      configs,
    }
  })

  app.put<{ Params: { taskKey: string } }>('/v1/admin/ai/bindings/:taskKey', async request => {
    await writeGuard(request)
    const taskKey = taskKeyParam(request.params.taskKey)
    const body = asObject(request.body)
    const primaryRaw = body.primaryConfigId
    if (primaryRaw === null || primaryRaw === undefined) {
      await pool.query('DELETE FROM llm_task_bindings WHERE task_key = $1', [taskKey])
      return { taskKey, label: TASK_LABELS[taskKey], purpose: taskPurpose(taskKey), primaryConfigId: null, fallbackConfigId: null, updatedAt: null }
    }
    if (typeof primaryRaw !== 'string' || !CONFIG_ID.test(primaryRaw)) {
      throw badRequest('primaryConfigId invalid')
    }
    const fallbackRaw = body.fallbackConfigId
    if (fallbackRaw !== null && fallbackRaw !== undefined
      && (typeof fallbackRaw !== 'string' || !CONFIG_ID.test(fallbackRaw))) {
      throw badRequest('fallbackConfigId invalid')
    }
    if (fallbackRaw === primaryRaw) throw badRequest('fallbackConfigId must differ from primaryConfigId')

    const purpose = taskPurpose(taskKey)
    const primary = await models.getLlm(primaryRaw)
    if (primary.purpose !== purpose) throw badRequest(`primary config must have purpose ${purpose}`)
    if (!primary.isActive) throw conflict('primary config is disabled')
    if (typeof fallbackRaw === 'string') {
      const fallback = await models.getLlm(fallbackRaw)
      if (fallback.purpose !== purpose) throw badRequest(`fallback config must have purpose ${purpose}`)
      if (!fallback.isActive) throw conflict('fallback config is disabled')
    }

    const { rows } = await pool.query<{
      task_key: string
      primary_config_id: string
      fallback_config_id: string | null
      updated_at: Date
    }>(
      `INSERT INTO llm_task_bindings (task_key, primary_config_id, fallback_config_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (task_key) DO UPDATE SET
         primary_config_id = EXCLUDED.primary_config_id,
         fallback_config_id = EXCLUDED.fallback_config_id,
         updated_at = now()
       RETURNING task_key, primary_config_id, fallback_config_id, updated_at`,
      [taskKey, primaryRaw, typeof fallbackRaw === 'string' ? fallbackRaw : null],
    )
    const row = rows[0]!
    return {
      taskKey: row.task_key,
      label: TASK_LABELS[taskKey],
      purpose,
      primaryConfigId: row.primary_config_id,
      fallbackConfigId: row.fallback_config_id,
      updatedAt: row.updated_at.toISOString(),
    }
  })

  app.get('/v1/admin/ai/health', async request => {
    await readGuard(request)
    const { rows } = await pool.query<{
      config_id: string
      name: string
      provider: string
      model: string
      purpose: string
      is_active: boolean
      consecutive_failures: number | null
      cooldown_until: Date | null
      last_error: string | null
      last_failure_at: Date | null
      last_success_at: Date | null
    }>(
      `SELECT c.config_id, c.name, c.provider, c.model, c.purpose, c.is_active,
              h.consecutive_failures, h.cooldown_until, h.last_error,
              h.last_failure_at, h.last_success_at
       FROM llm_configs c
       LEFT JOIN llm_config_health h ON h.config_id = c.config_id
       ORDER BY c.is_default DESC, c.created_at`,
    )
    return {
      configs: rows.map(row => ({
        configId: row.config_id,
        name: row.name,
        provider: row.provider,
        model: row.model,
        purpose: row.purpose,
        isActive: row.is_active,
        consecutiveFailures: row.consecutive_failures ?? 0,
        cooldownUntil: iso(row.cooldown_until),
        coolingDown: row.cooldown_until !== null && row.cooldown_until.getTime() > Date.now(),
        lastError: row.last_error,
        lastFailureAt: iso(row.last_failure_at),
        lastSuccessAt: iso(row.last_success_at),
      })),
    }
  })
}
