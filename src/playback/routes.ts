import type { FastifyInstance } from 'fastify'
import type { AuthService } from '../auth/service.js'
import { requirePrincipal } from '../http/principal.js'
import { asObject, stringField } from '../http/validation.js'
import type { PlaybackService } from './service.js'

export interface PlaybackRouteDeps {
  playback: PlaybackService
  auth: AuthService
}

export function registerPlaybackRoutes(app: FastifyInstance, deps: PlaybackRouteDeps): void {
  app.post('/v1/playback/sessions', async request => {
    const principal = await requirePrincipal(request, deps.auth)
    const body = asObject(request.body)
    const segmentId = stringField(body, 'segmentId', { max: 80 })
    return deps.playback.createSession(principal, segmentId)
  })
}
