import type { FastifyInstance } from 'fastify'
import type { AuthService } from '../auth/service.js'
import { hashToken } from '../auth/tokens.js'
import type { AppConfig } from '../config.js'
import { forbidden, tooManyRequests } from '../errors.js'
import { requirePrincipal } from '../http/principal.js'
import { RateLimiter } from '../rate-limit.js'
import { EventService, parseEventBody } from './service.js'

export interface EventRouteDeps {
  events: EventService
  auth: AuthService
  config: AppConfig
  limiter: RateLimiter
}

export function registerEventRoutes(app: FastifyInstance, deps: EventRouteDeps): void {
  const { events, auth, config, limiter } = deps

  app.post('/v1/events', async (request, reply) => {
    const principal = await requirePrincipal(request, auth)
    if (!limiter.take(`events:${principal.deviceId}`, config.rateLimitEventsPerMinute)) {
      throw tooManyRequests()
    }
    if (!(await auth.eventsConsent(principal.userId))) throw forbidden('events consent required')
    const event = parseEventBody(request.body)
    await events.record(principal, hashToken(principal.deviceId), event)
    return reply.code(202).send({ accepted: true })
  })
}
