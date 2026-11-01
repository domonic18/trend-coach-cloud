import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import type { Pool } from 'pg'
import { createLongFormAsr, type LongFormAsr } from '../asr/longform.js'
import type { AppConfig } from '../config.js'
import { serviceUnavailable } from '../errors.js'
import type { Metrics } from '../metrics.js'
import type { ModelConfigService } from '../model-config/service.js'
import { checkMediaTools } from './ffmpeg.js'
import { createGenerationHook } from './generation.js'
import { JobQueue } from './jobs.js'
import type { LlmClient } from './llm.js'
import { createLocalMediaProcessor, type MediaProcessor } from './media-processor.js'
import { createLocalMediaStore, type MediaStore } from './media-store.js'
import { PipelineService, type PipelineApi } from './service.js'
import { PipelineWorker, type GenerationHook, type WorkerLogger } from './worker.js'

export interface PipelineRuntime {
  enabled: boolean
  api: PipelineApi
  start(): Promise<void>
  stop(): Promise<void>
}

export interface PipelineRuntimeInput {
  pool: Pool
  config: AppConfig
  metrics: Metrics
  log: WorkerLogger
  /** 生产环境由 app 注入；测试可用 asr/llm 直连覆盖。 */
  models?: ModelConfigService
  store?: MediaStore
  processor?: MediaProcessor
  /** 测试注入；生产环境走数据库配置。 */
  asr?: LongFormAsr
  generator?: GenerationHook
  llm?: LlmClient
  reindex?: (courseId: string) => Promise<{ embedded: number }>
}

/** 未启用时保留路由，管理端拿到 503 而不是 404。 */
export function createDisabledPipelineApi(): PipelineApi {
  const fail = async (): Promise<never> => {
    throw serviceUnavailable('pipeline disabled')
  }
  return {
    listAssets: fail,
    createAsset: fail,
    patchAsset: fail,
    uploadSource: fail,
    enqueueIngest: fail,
    getTranscript: fail,
    enqueueGeneration: fail,
    getGeneration: fail,
    applyGeneration: fail,
    discardGeneration: fail,
    publishCourse: fail,
    listJobs: fail,
    getJob: fail,
    retryJob: fail,
    cancelJob: fail,
  }
}

export async function createPipelineRuntime(input: PipelineRuntimeInput): Promise<PipelineRuntime> {
  const config = input.config.pipeline
  if (config === undefined) {
    return {
      enabled: false,
      api: createDisabledPipelineApi(),
      start: async () => undefined,
      stop: async () => undefined,
    }
  }

  await mkdir(config.storageDir, { recursive: true })
  await mkdir(config.hlsDir, { recursive: true })
  try {
    await access(config.storageDir, constants.W_OK)
    await access(config.hlsDir, constants.W_OK)
  } catch {
    throw new Error('config: 管线存储目录或 HLS 目录不可写')
  }

  if (input.processor === undefined) {
    await checkMediaTools({ ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath })
  }

  const store = input.store ?? createLocalMediaStore({
    storageDir: config.storageDir,
    hlsDir: config.hlsDir,
  })
  const processor = input.processor ?? createLocalMediaProcessor({
    store,
    tools: { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath },
    maxSourceSeconds: config.maxSourceSeconds,
  })

  const resolveAsr = async (): Promise<{ asr: LongFormAsr; model: string } | undefined> => {
    if (input.asr !== undefined) return { asr: input.asr, model: 'test' }
    const resolved = await input.models?.resolveAsr()
    return resolved === undefined
      ? undefined
      : { asr: createLongFormAsr(resolved), model: resolved.model }
  }
  const resolveLlm = async (): Promise<{ llm: LlmClient; model: string } | undefined> => {
    if (input.llm !== undefined) return { llm: input.llm, model: 'test' }
    const resolved = await input.models?.resolveLlm('content')
    return resolved === undefined ? undefined : { llm: resolved.client, model: resolved.model }
  }

  const generator = input.generator ?? createGenerationHook({
    pool: input.pool,
    config,
    resolveLlm,
  })
  const jobs = new JobQueue(input.pool, config.maxAttempts)
  const api = new PipelineService(input.pool, config, jobs, store, {
    llmAvailable: async () =>
      input.llm !== undefined || (await input.models?.resolveLlm('content')) !== undefined,
    embeddingAvailable: async () => input.models === undefined || input.models.hasEmbedding(),
    ...(input.reindex === undefined ? {} : { reindex: input.reindex }),
  })
  const worker = new PipelineWorker({
    pool: input.pool,
    config,
    jobs,
    store,
    processor,
    resolveAsr,
    asrLongTimeoutMs: input.config.asrLongTimeoutMs,
    generator,
    log: input.log,
    metrics: input.metrics,
  })

  return {
    enabled: true,
    api,
    start: async () => worker.start(),
    stop: () => worker.stop(),
  }
}
