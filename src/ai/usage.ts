import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AiTaskKey } from './tasks.js'

export type AiRunSource = 'pipeline' | 'admin'
export type AiUsageStatus = 'success' | 'error' | 'fallback'

export interface AiRunHandle {
  runId: string
  taskKey: AiTaskKey
  source: AiRunSource
  sourceId?: string
  fallbackUsed: boolean
}

export interface AiCallRecord {
  taskKey: AiTaskKey
  configId?: string
  provider?: string
  model?: string
  status: AiUsageStatus
  errorCode?: string
  attempt?: number
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  audioSeconds?: number
  characters?: number
  images?: number
  /** 生成时单价换算的成本，预算统计只读此列。 */
  costMicros?: number
  /** 按课程归集图片预算；非课程任务留空。 */
  courseId?: string
}

const MAX_ERROR = 64

function trimError(value: string | undefined): string | null {
  return value === undefined ? null : value.slice(0, MAX_ERROR)
}

/**
 * 用量账本只存数字与模型标识，不落 prompt、正文或 provider 响应体。
 * 每次调用直接落库：调用频率远低于请求量，避免缓冲丢失。
 */
export class AiUsageService {
  constructor(private readonly pool: Pool) {}

  async startRun(input: {
    taskKey: AiTaskKey
    source: AiRunSource
    sourceId?: string
    primaryConfigId?: string
  }): Promise<AiRunHandle> {
    const runId = randomUUID()
    await this.pool.query(
      `INSERT INTO ai_runs (run_id, task_key, source, source_id, status, primary_config_id)
       VALUES ($1, $2, $3, $4, 'running', $5)`,
      [runId, input.taskKey, input.source, input.sourceId ?? null, input.primaryConfigId ?? null],
    )
    return {
      runId,
      taskKey: input.taskKey,
      source: input.source,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      fallbackUsed: false,
    }
  }

  /** 一次 AI 调用 = 一条用量 + 一条运行步骤；步骤序号由数据库原子分配。 */
  async recordCall(handle: AiRunHandle | undefined, record: AiCallRecord): Promise<void> {
    const { rows } = handle === undefined
      ? { rows: [] as { step_seq: number }[] }
      : await this.pool.query<{ step_seq: number }>(
        'UPDATE ai_runs SET step_seq = step_seq + 1 WHERE run_id = $1 RETURNING step_seq',
        [handle.runId],
      )
    const usageRows = await this.pool.query<{ usage_id: string }>(
      `INSERT INTO ai_usage_events
         (run_id, task_key, provider, model, config_id, input_tokens, output_tokens, cached_tokens,
          audio_seconds, characters, images, cost_micros, course_id, latency_ms, status, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING usage_id`,
      [
        handle?.runId ?? null,
        record.taskKey,
        record.provider ?? null,
        record.model ?? null,
        record.configId ?? null,
        record.inputTokens ?? 0,
        record.outputTokens ?? 0,
        record.cachedTokens ?? 0,
        record.audioSeconds ?? 0,
        record.characters ?? 0,
        record.images ?? 0,
        record.costMicros ?? 0,
        record.courseId ?? null,
        record.latencyMs,
        record.status,
        trimError(record.errorCode),
      ],
    )
    if (handle === undefined) return
    const seq = rows[0]?.step_seq
    if (seq === undefined) return
    await this.pool.query(
      `INSERT INTO ai_run_steps
         (run_id, seq, task_key, config_id, provider, model, attempt, status, latency_ms, usage_id, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        handle.runId,
        seq,
        record.taskKey,
        record.configId ?? null,
        record.provider ?? null,
        record.model ?? null,
        record.attempt ?? 1,
        record.status === 'error' ? 'error' : 'success',
        record.latencyMs,
        usageRows.rows[0]?.usage_id ?? null,
        trimError(record.errorCode),
      ],
    )
  }

  async finishRun(
    handle: AiRunHandle,
    status: 'succeeded' | 'failed',
    options: { errorCode?: string; fallbackUsed?: boolean } = {},
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ai_runs
       SET status = $2, finished_at = now(), error_code = $3, fallback_used = $4
       WHERE run_id = $1`,
      [handle.runId, status, trimError(options.errorCode), options.fallbackUsed ?? handle.fallbackUsed],
    )
  }

  /** ASR 按分块调用，没有独立的 run；直接记用量。 */
  async recordStandalone(record: AiCallRecord): Promise<void> {
    await this.recordCall(undefined, record)
  }
}
