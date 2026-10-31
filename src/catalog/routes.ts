import type { FastifyInstance } from 'fastify'
import type { AuthService } from '../auth/service.js'
import { requirePrincipal } from '../http/principal.js'
import { CatalogService } from './service.js'

export interface CatalogRouteDeps {
  catalog: CatalogService
  auth: AuthService
}

export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogRouteDeps): void {
  const { catalog, auth } = deps

  app.get('/v1/catalog/courses', async request => {
    const principal = await requirePrincipal(request, auth)
    return catalog.listCourses(principal.userId)
  })

  app.get('/v1/catalog/courses/:courseId', async request => {
    const principal = await requirePrincipal(request, auth)
    const { courseId } = request.params as { courseId: string }
    return catalog.getCourse(courseId, principal.userId)
  })

  app.get('/v1/catalog/knowledge-points/:knowledgePointId', async request => {
    await requirePrincipal(request, auth)
    const { knowledgePointId } = request.params as { knowledgePointId: string }
    return catalog.getKnowledgePoint(knowledgePointId)
  })
}
