import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { AuthService } from './auth/service.js'
import { registerAuthRoutes } from './auth/routes.js'
import { safeEqual } from './auth/tokens.js'
import type { AppConfig } from './config.js'
import { EventService } from './events/service.js'
import { registerEventRoutes } from './events/routes.js'
import { HttpError } from './errors.js'
import { createMetrics } from './metrics.js'
import { RateLimiter } from './rate-limit.js'
import { createEmbeddingProvider } from './kb/embedding.js'
import { KnowledgeService } from './kb/service.js'
import { registerKbRoutes } from './kb/routes.js'
import { registerMediaRoutes } from './media/routes.js'
import { PlaybackService } from './playback/service.js'
import { registerPlaybackRoutes } from './playback/routes.js'

export interface BuildAppOptions {
  config: AppConfig
  pool: Pool
  /** 测试用：收集已注册路由，与 OpenAPI 做一致性校验。 */
  onRoute?: (method: string, url: string) => void
}

export async function buildApp({ config, pool, onRoute }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers["x-device-id"]', 'req.headers["x-console-token"]'],
    },
    bodyLimit: 64 * 1024,
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
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-device-id'],
  })

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id)
    reply.header('x-content-type-options', 'nosniff')
    return payload
  })

  const metrics = createMetrics()

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
    if (authorization === undefined || !safeEqual(authorization, `Bearer ${config.consoleToken}`)) {
      return reply.code(401).send({ error: 'unauthorized', requestId: request.id })
    }
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics())
  })

  const limiter = new RateLimiter()
  const timer = setInterval(() => limiter.prune(), 60_000)
  timer.unref()
  app.addHook('onClose', async () => clearInterval(timer))

  const auth = new AuthService(pool, config)
  const embed = config.embedding === undefined ? undefined : createEmbeddingProvider(config.embedding)
  const kb = new KnowledgeService(pool, config, embed)
  const playback = new PlaybackService(pool, config, auth)
  const events = new EventService(pool)

  registerAuthRoutes(app, { auth, config, limiter })
  registerKbRoutes(app, { kb, auth, config, limiter })
  registerPlaybackRoutes(app, { playback, auth })
  registerEventRoutes(app, { events, auth, config, limiter })
  if (config.mediaLocalDir !== undefined) registerMediaRoutes(app, { config, pool })

  return app
}
