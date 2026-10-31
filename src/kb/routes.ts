import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { tooManyRequests } from '../errors.js'
import { requirePrincipal } from '../http/principal.js'
import { RateLimiter } from '../rate-limit.js'
import type { AuthService } from '../auth/service.js'
import { KnowledgeService, parseSearchBody } from './service.js'

export interface KbRouteDeps {
  kb: KnowledgeService
  auth: AuthService
  config: AppConfig
  limiter: RateLimiter
}

export function registerKbRoutes(app: FastifyInstance, deps: KbRouteDeps): void {
  const { kb, auth, config, limiter } = deps

  app.post('/v1/kb/search', async request => {
    const principal = await requirePrincipal(request, auth)
    if (!limiter.take(`search:${principal.deviceId}`, config.rateLimitSearchPerMinute)) {
      throw tooManyRequests()
    }
    return kb.search(parseSearchBody(request.body))
  })

  app.get('/v1/kb/segments/:segmentId', async request => {
    await requirePrincipal(request, auth)
    const { segmentId } = request.params as { segmentId: string }
    return kb.getSegment(segmentId)
  })
}
