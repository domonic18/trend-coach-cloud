import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { AiRouter } from '../ai/routing.js'
import { AiUsageService } from '../ai/usage.js'
import { createLongFormAsr, type LongFormAsr } from '../asr/longform.js'
import type { AppConfig } from '../config.js'
import { serviceUnavailable } from '../errors.js'
import { createIllustrationHook } from '../illustration/hook.js'
import { createFigureStore } from '../illustration/store.js'
import type { Metrics } from '../metrics.js'
import type { ModelConfigService, ResolvedImage } from '../model-config/service.js'
import { checkMediaTools } from './ffmpeg.js'
import { createGenerationHook } from './generation.js'
import { JobQueue } from './jobs.js'
import type { LlmClient } from './llm.js'
import { createLocalMediaProcessor, type MediaProcessor } from './media-processor.js'
import { createLocalMediaStore, type MediaStore } from './media-store.js'
import { PipelineService, type PipelineApi } from './service.js'
import {
  PipelineWorker,
  type GenerationHook,
  type IllustrationHook,
  type WorkerLogger,
} from './worker.js'

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
  illustrator?: IllustrationHook
  llm?: LlmClient
  /** 测试注入：固定图片模型或未配置。 */
  image?: ResolvedImage | null
  /** 与 app 共用同一路由器，冷却状态与用量账本只有一份。 */
  ai?: AiRouter
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
    enqueueIllustrate: fail,
    listFigures: fail,
    selectFigure: fail,
    regenerateFigure: fail,
    deleteFigure: fail,
    candidateFile: fail,
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

  const figureDir = input.config.figureLocalDir ?? resolve(config.storageDir, '..', 'figures')
  await mkdir(config.storageDir, { recursive: true })
  await mkdir(config.hlsDir, { recursive: true })
  await mkdir(figureDir, { recursive: true })
  try {
    await access(config.storageDir, constants.W_OK)
    await access(config.hlsDir, constants.W_OK)
    await access(figureDir, constants.W_OK)
  } catch {
    throw new Error('config: 管线存储目录、HLS 目录或图示目录不可写')
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
  const resolveImage = async (): Promise<ResolvedImage | undefined> => {
    if (input.image !== undefined) return input.image ?? undefined
    return input.models?.resolveImage()
  }

  // 测试注入 llm/generator 时走直连；生产走任务绑定 + 计量 + 主备切换。
  const usage = input.models !== undefined && input.llm === undefined
    ? new AiUsageService(input.pool)
    : undefined
  const ai = input.ai ?? (usage === undefined || input.models === undefined || input.generator !== undefined
    ? undefined
    : new AiRouter({ pool: input.pool, models: input.models, usage }))

  const generator = input.generator ?? createGenerationHook({
    pool: input.pool,
    config,
    resolveLlm,
    ...(ai === undefined ? {} : { ai }),
  })
  const illustrator = input.illustrator ?? createIllustrationHook({
    pool: input.pool,
    config,
    store,
    figureStore: createFigureStore(figureDir),
    tools: { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath },
    resolveImage,
    ...(usage === undefined ? {} : { usage }),
    log: input.log,
  })
  const jobs = new JobQueue(input.pool, config.maxAttempts)
  const api = new PipelineService(input.pool, config, jobs, store, {
    llmAvailable: async () =>
      input.llm !== undefined || (await input.models?.resolveLlm('content')) !== undefined,
    embeddingAvailable: async () => input.models === undefined || input.models.hasEmbedding(),
    image: async () => {
      const resolved = await resolveImage()
      return resolved === undefined ? undefined : { priceMicros: resolved.priceMicros }
    },
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
    illustrator,
    log: input.log,
    metrics: input.metrics,
    ...(usage === undefined ? {} : { usage }),
  })

  return {
    enabled: true,
    api,
    start: async () => worker.start(),
    stop: () => worker.stop(),
  }
}
