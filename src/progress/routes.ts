import type { FastifyInstance } from 'fastify'
import type { AuthService } from '../auth/service.js'
import type { AppConfig } from '../config.js'
import { tooManyRequests } from '../errors.js'
import { requirePrincipal } from '../http/principal.js'
import { RateLimiter } from '../rate-limit.js'
import { ProgressService, parseProgressBody } from './service.js'

export interface ProgressRouteDeps {
  progress: ProgressService
  auth: AuthService
  config: AppConfig
  limiter: RateLimiter
}

export function registerProgressRoutes(app: FastifyInstance, deps: ProgressRouteDeps): void {
  const { progress, auth, config, limiter } = deps

  app.put('/v1/progress/knowledge-points/:knowledgePointId', async request => {
    const principal = await requirePrincipal(request, auth)
    if (!limiter.take(`progress:${principal.deviceId}`, config.rateLimitProgressPerMinute)) {
      throw tooManyRequests()
    }
    const { knowledgePointId } = request.params as { knowledgePointId: string }
    return progress.report(principal, knowledgePointId, parseProgressBody(request.body))
  })
}
