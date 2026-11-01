import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { AccountService } from './accounts/service.js'
import { registerAccountRoutes } from './accounts/routes.js'
import { createMiniMaxProvider, type AsrProvider } from './asr/provider.js'
import { registerAsrRoutes } from './asr/routes.js'
import { AuthService } from './auth/service.js'
import { registerAuthRoutes } from './auth/routes.js'
import { safeEqual } from './auth/tokens.js'
import { CatalogService } from './catalog/service.js'
import { registerCatalogRoutes } from './catalog/routes.js'
import type { AppConfig } from './config.js'
import { ContentService } from './content/service.js'
import { registerContentRoutes } from './content/routes.js'
import { EventService } from './events/service.js'
import { registerEventRoutes } from './events/routes.js'
import { HttpError } from './errors.js'
import { createMetrics, type Metrics } from './metrics.js'
import { RateLimiter } from './rate-limit.js'
import { createEmbeddingProvider } from './kb/embedding.js'
import { KnowledgeService } from './kb/service.js'
import { registerKbRoutes } from './kb/routes.js'
import { registerMediaRoutes } from './media/routes.js'
import { PlaybackService } from './playback/service.js'
import { registerPlaybackRoutes } from './playback/routes.js'
import { ProgressService } from './progress/service.js'
import { registerProgressRoutes } from './progress/routes.js'
import { registerPipelineRoutes } from './pipeline/routes.js'
import { createPipelineRuntime, type PipelineRuntime } from './pipeline/runtime.js'

export interface BuildAppOptions {
  config: AppConfig
  pool: Pool
  /** 测试用：注入 fake provider，不访问真实 MiniMax。 */
  asr?: AsrProvider
  /** 测试用：收集已注册路由，与 OpenAPI 做一致性校验。 */
  onRoute?: (method: string, url: string) => void
  /** 测试用：注入已装配的管线运行时（可带假处理器/假 ASR）。 */
  pipeline?: PipelineRuntime
  /** 测试用：与注入的管线运行时共用同一注册表。 */
  metrics?: Metrics
  /** 仅生产入口启动 worker；测试默认不启动，避免后台轮询干扰断言。 */
  startPipeline?: boolean
}

export async function buildApp({
  config,
  pool,
  onRoute,
  asr: injectedAsr,
  pipeline: injectedPipeline,
  metrics: injectedMetrics,
  startPipeline = false,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers["x-device-id"]'],
    },
    bodyLimit: 128 * 1024,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
  })

  if (onRoute !== undefined) {
    app.addHook('onRoute', route => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) onRoute(method, route.url)
    })
  }

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-device-id'],
  })

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id)
    reply.header('x-content-type-options', 'nosniff')
    return payload
  })

  const metrics = injectedMetrics ?? createMetrics()

  app.addHook('onResponse', async (request, reply) => {
    const labels = {
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status: String(reply.statusCode),
    }
    metrics.httpRequests.inc(labels)
    metrics.httpDuration.observe(labels, reply.elapsedTime / 1000)
    request.log.info({
      requestId: request.id,
      method: request.method,
      path: request.url.split('?')[0],
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    }, 'request completed')
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      if (error.statusCode === 429) reply.header('retry-after', '60')
      reply.code(error.statusCode).send({ error: error.message, requestId: request.id })
      return
    }
    if (error.statusCode === 413) {
      reply.code(413).send({ error: 'payload too large', requestId: request.id })
      return
    }
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      reply.code(error.statusCode).send({ error: 'invalid request', requestId: request.id })
      return
    }
    request.log.error({ err: error, requestId: request.id }, 'unhandled error')
    reply.code(500).send({ error: 'internal error', requestId: request.id })
  })

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not found', requestId: request.id })
  })

  app.get('/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1')
      return { ok: true }
    } catch {
      return reply.code(503).send({ ok: false })
    }
  })

  app.get('/metrics', async (request, reply) => {
    const authorization = request.headers.authorization
    if (authorization === undefined || !safeEqual(authorization, `Bearer ${config.metricsToken}`)) {
      return reply.code(401).send({ error: 'unauthorized', requestId: request.id })
    }
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics())
  })

  const limiter = new RateLimiter()
  const timer = setInterval(() => limiter.prune(), 60_000)
  timer.unref()
  app.addHook('onClose', async () => clearInterval(timer))

  const auth = new AuthService(pool, config)
  const accounts = new AccountService(pool, config)
  const bootstrap = await accounts.bootstrapAdmin()
  if (bootstrap.created) app.log.info('bootstrap admin created')
  const embed = config.embedding === undefined ? undefined : createEmbeddingProvider(config.embedding)
  const kb = new KnowledgeService(pool, config, embed)
  const playback = new PlaybackService(pool, config, auth)
  const events = new EventService(pool)
  const catalog = new CatalogService(pool)
  const progress = new ProgressService(pool)
  const content = new ContentService(pool, embed)
  const asr = injectedAsr ?? (config.asr === undefined ? undefined : createMiniMaxProvider(config.asr))
  const pipeline = injectedPipeline ?? await createPipelineRuntime({
    pool,
    config,
    metrics,
    log: app.log,
    ...(embed === undefined ? {} : { reindex: (courseId: string) => content.reindex(courseId) }),
  })

  registerAuthRoutes(app, { auth, accounts, config, limiter })
  registerAccountRoutes(app, { accounts, config, limiter })
  registerKbRoutes(app, { kb, auth, config, limiter })
  registerPlaybackRoutes(app, { playback, auth })
  registerEventRoutes(app, { events, auth, config, limiter })
  registerCatalogRoutes(app, { catalog, auth, config, limiter })
  registerProgressRoutes(app, { progress, auth, config, limiter })
  registerAsrRoutes(app, {
    ...(asr === undefined ? {} : { asr }),
    auth,
    config,
    limiter,
  })
  registerContentRoutes(app, { content, accounts, config, limiter })
  await registerPipelineRoutes(app, { api: pipeline.api, accounts, config, limiter })
  if (config.mediaLocalDir !== undefined) registerMediaRoutes(app, { config, pool })

  app.addHook('onClose', async () => pipeline.stop())
  if (startPipeline) await pipeline.start()

  const adminDir = join(process.cwd(), 'dist', 'admin')
  if (existsSync(join(adminDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: adminDir,
      prefix: '/admin/',
      index: ['index.html'],
      cacheControl: false,
      // 入口页每次回源，避免发布后仍用旧 bundle；哈希资源可长缓存。
      setHeaders: (reply, filePath) => {
        reply.header(
          'cache-control',
          filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
        )
      },
    })
    app.get('/admin', async (_request, reply) => reply.redirect('/admin/'))
  }

  return app
}
