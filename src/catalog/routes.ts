import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthService, Principal } from '../auth/service.js'
import type { AppConfig } from '../config.js'
import { tooManyRequests } from '../errors.js'
import { requirePrincipal } from '../http/principal.js'
import type { RateLimiter } from '../rate-limit.js'
import { CatalogService } from './service.js'

export interface CatalogRouteDeps {
  catalog: CatalogService
  auth: AuthService
  config: AppConfig
  limiter: RateLimiter
}

export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogRouteDeps): void {
  const { catalog, auth, config, limiter } = deps

  const guard = async (request: FastifyRequest): Promise<Principal> => {
    const principal = await requirePrincipal(request, auth)
    if (!limiter.take(`catalog:${principal.deviceId}`, config.rateLimitCatalogPerMinute)) {
      throw tooManyRequests()
    }
    return principal
  }

  app.get('/v1/catalog/courses', async request => {
    const principal = await guard(request)
    return catalog.listCourses(principal.userId)
  })

  app.get('/v1/catalog/courses/:courseId', async request => {
    const principal = await guard(request)
    const { courseId } = request.params as { courseId: string }
    return catalog.getCourse(courseId, principal.userId)
  })

  app.get('/v1/catalog/knowledge-points/:knowledgePointId', async request => {
    await guard(request)
    const { knowledgePointId } = request.params as { knowledgePointId: string }
    return catalog.getKnowledgePoint(knowledgePointId)
  })
}
