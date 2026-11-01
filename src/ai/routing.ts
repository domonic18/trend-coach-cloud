import type { Pool } from 'pg'
import { serviceUnavailable } from '../errors.js'
import { createEmbeddingProvider, type EmbeddingAttempt, type EmbeddingTask } from '../kb/embedding.js'
import type { ModelConfigService, ResolvedLlm } from '../model-config/service.js'
import { LlmError, type LlmRequest, type LlmUsage } from '../pipeline/llm.js'
import { JobCanceledError } from '../pipeline/failures.js'
import type { AiTaskKey, LlmTaskKey } from './tasks.js'
import type { AiRunHandle, AiRunSource, AiUsageService } from './usage.js'

const DEFAULT_COOLDOWN_MS = 60_000

interface FailureInfo {
  code: string
  retryable: boolean
}

export interface AiCompletion<T> {
  value: T
  model: string
  configId: string
  fallbackUsed: boolean
}

export interface AiRouterOptions {
  pool: Pool
  models: ModelConfigService
  usage: AiUsageService
  cooldownMs?: number
}

function describeLlmFailure(error: unknown): FailureInfo {
  if (error instanceof LlmError) {
    switch (error.kind) {
      case 'rate_limited': return { code: 'rate_limited', retryable: true }
      case 'unavailable': return { code: 'unavailable', retryable: true }
      case 'truncated': return { code: 'truncated', retryable: false }
      case 'input_too_large': return { code: 'input_too_large', retryable: false }
      case 'invalid_response': return { code: 'invalid_response', retryable: false }
    }
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { code: 'timeout', retryable: true }
  }
  return { code: 'unavailable', retryable: true }
}

function describeEmbeddingFailure(attempt: EmbeddingAttempt | undefined): FailureInfo {
  if (attempt === undefined) return { code: 'unavailable', retryable: true }
  if (attempt.status === 'network') return { code: 'network', retryable: true }
  const code = `http_${attempt.status}`
  if (attempt.status === 429 || attempt.status >= 500) return { code, retryable: true }
  return { code, retryable: false }
}

/**
 * 任务级模型路由：绑定优先、冷却跳过、主备单跳切换。
 * 每次调用都落用量；健康状态进程内 Map + 数据库双写，单实例部署足够。
 */
export class AiRouter {
  private readonly cooldowns = new Map<string, number>()
  private readonly cooldownMs: number

  constructor(private readonly options: AiRouterOptions) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
  }

  startRun(taskKey: AiTaskKey, source: AiRunSource, sourceId?: string): Promise<AiRunHandle> {
    return this.options.usage.startRun({
      taskKey,
      source,
      ...(sourceId === undefined ? {} : { sourceId }),
    })
  }

  finishRun(
    handle: AiRunHandle,
    status: 'succeeded' | 'failed',
    options: { errorCode?: string } = {},
  ): Promise<void> {
    return this.options.usage.finishRun(handle, status, {
      ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
      fallbackUsed: handle.fallbackUsed,
    })
  }

  async completeJson<T>(
    handle: AiRunHandle | undefined,
    taskKey: LlmTaskKey,
    request: LlmRequest,
    parse: (value: unknown) => T,
  ): Promise<AiCompletion<T>> {
    const resolved = await this.options.models.resolveTaskModels(taskKey)
    const candidates = await this.usable([resolved.primary, resolved.fallback])
    if (candidates.length === 0) throw new LlmError('unavailable')

    let lastError: unknown
    for (const [index, candidate] of candidates.entries()) {
      if (request.signal?.aborted === true) throw new JobCanceledError()
      const startedAt = Date.now()
      let usage: LlmUsage | undefined
      try {
        const value = await candidate.client.completeJson({
          ...request,
          onUsage: observed => {
            usage = observed
            request.onUsage?.(observed)
          },
        }, parse)
        await this.markSuccess(candidate.configId).catch(() => undefined)
        await this.options.usage.recordCall(handle, {
          taskKey,
          configId: candidate.configId,
          provider: candidate.provider,
          model: candidate.model,
          status: index > 0 ? 'fallback' : 'success',
          attempt: index + 1,
          latencyMs: Date.now() - startedAt,
          ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
          ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
          ...(usage?.cachedTokens === undefined ? {} : { cachedTokens: usage.cachedTokens }),
        })
        if (index > 0 && handle !== undefined) handle.fallbackUsed = true
        return { value, model: candidate.model, configId: candidate.configId, fallbackUsed: index > 0 }
      } catch (error) {
        if (request.signal?.aborted) throw new JobCanceledError()
        const failure = describeLlmFailure(error)
        await this.markFailure(candidate.configId, failure).catch(() => undefined)
        await this.options.usage.recordCall(handle, {
          taskKey,
          configId: candidate.configId,
          provider: candidate.provider,
          model: candidate.model,
          status: 'error',
          errorCode: failure.code,
          attempt: index + 1,
          latencyMs: Date.now() - startedAt,
        })
        lastError = error
        if (!failure.retryable) throw error
      }
    }
    throw lastError ?? new LlmError('unavailable')
  }

  /** 返回绑定后的 provider；未配置向量模型时返回 undefined，调用方退化为纯词法。 */
  async embeddingProvider(
    taskKey: EmbeddingTask,
  ): Promise<((text: string) => Promise<number[]>) | undefined> {
    const resolved = await this.options.models.resolveTaskModels(taskKey)
    const candidates = this.ordered([resolved.primary, resolved.fallback])
    if (candidates.length === 0) return undefined
    return text => this.embedWithCandidates(taskKey, candidates, text)
  }

  private async embedWithCandidates(
    taskKey: EmbeddingTask,
    candidates: ResolvedLlm[],
    text: string,
  ): Promise<number[]> {
    const usable = await this.usable(candidates)
    const plan = usable.length > 0 ? usable : candidates
    let lastError: unknown
    for (const [index, candidate] of plan.entries()) {
      const startedAt = Date.now()
      let attempt: EmbeddingAttempt | undefined
      try {
        const provider = createEmbeddingProvider(candidate.config, observed => {
          attempt = observed
        })
        const vector = await provider(text)
        await this.markSuccess(candidate.configId).catch(() => undefined)
        await this.options.usage.recordStandalone({
          taskKey,
          configId: candidate.configId,
          provider: candidate.provider,
          model: candidate.model,
          status: index > 0 ? 'fallback' : 'success',
          attempt: index + 1,
          latencyMs: Date.now() - startedAt,
          ...(attempt?.inputTokens === undefined ? {} : { inputTokens: attempt.inputTokens }),
        })
        return vector
      } catch (error) {
        const failure = describeEmbeddingFailure(attempt)
        await this.markFailure(candidate.configId, failure).catch(() => undefined)
        await this.options.usage.recordStandalone({
          taskKey,
          configId: candidate.configId,
          provider: candidate.provider,
          model: candidate.model,
          status: 'error',
          errorCode: failure.code,
          attempt: index + 1,
          latencyMs: Date.now() - startedAt,
        })
        lastError = error
        if (!failure.retryable) throw error
      }
    }
    throw lastError ?? serviceUnavailable('embedding service unavailable')
  }

  private ordered(candidates: (ResolvedLlm | undefined)[]): ResolvedLlm[] {
    return candidates.filter((candidate): candidate is ResolvedLlm => candidate !== undefined)
  }

  /** 冷却中的模型直接跳过；全部冷却时仍按原顺序尝试，避免整体不可用。 */
  private async usable(candidates: (ResolvedLlm | undefined)[]): Promise<ResolvedLlm[]> {
    const list = this.ordered(candidates)
    const available: ResolvedLlm[] = []
    for (const candidate of list) {
      if (!await this.cooling(candidate.configId)) available.push(candidate)
    }
    return available.length > 0 ? available : list
  }

  private async cooling(configId: string): Promise<boolean> {
    const cached = this.cooldowns.get(configId)
    if (cached !== undefined) {
      if (cached > Date.now()) return true
      this.cooldowns.delete(configId)
    }
    const { rows } = await this.options.pool.query<{ cooldown_until: Date | null }>(
      'SELECT cooldown_until FROM llm_config_health WHERE config_id = $1',
      [configId],
    )
    const until = rows[0]?.cooldown_until?.getTime()
    if (until === undefined || until <= Date.now()) return false
    this.cooldowns.set(configId, until)
    return true
  }

  private async markFailure(configId: string, failure: FailureInfo): Promise<void> {
    const cooldownUntil = failure.retryable ? new Date(Date.now() + this.cooldownMs) : null
    if (cooldownUntil !== null) this.cooldowns.set(configId, cooldownUntil.getTime())
    await this.options.pool.query(
      `INSERT INTO llm_config_health
         (config_id, consecutive_failures, cooldown_until, last_error, last_failure_at, updated_at)
       VALUES ($1, 1, $2::timestamptz, $3, now(), now())
       ON CONFLICT (config_id) DO UPDATE SET
         consecutive_failures = llm_config_health.consecutive_failures + 1,
         cooldown_until = COALESCE($2::timestamptz, llm_config_health.cooldown_until),
         last_error = $3,
         last_failure_at = now(),
         updated_at = now()`,
      [configId, cooldownUntil, failure.code.slice(0, 500)],
    )
  }

  private async markSuccess(configId: string): Promise<void> {
    this.cooldowns.delete(configId)
    await this.options.pool.query(
      `INSERT INTO llm_config_health
         (config_id, consecutive_failures, cooldown_until, last_success_at, updated_at)
       VALUES ($1, 0, NULL, now(), now())
       ON CONFLICT (config_id) DO UPDATE SET
         consecutive_failures = 0,
         cooldown_until = NULL,
         last_error = NULL,
         last_success_at = now(),
         updated_at = now()`,
      [configId],
    )
  }
}
