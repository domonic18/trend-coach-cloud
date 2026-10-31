import type { FastifyRequest } from 'fastify'
import type { AuthService, Principal } from '../auth/service.js'
import { unauthorized } from '../errors.js'

export function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw unauthorized()
  const token = header.slice('Bearer '.length).trim()
  if (token === '') throw unauthorized()
  return token
}

export function deviceIdHeader(request: FastifyRequest): string | undefined {
  const header = request.headers['x-device-id']
  return Array.isArray(header) ? header[0] : header
}

export function requirePrincipal(request: FastifyRequest, auth: AuthService): Promise<Principal> {
  return auth.authenticate(bearerToken(request), deviceIdHeader(request))
}

export function clientIp(request: FastifyRequest): string {
  return request.ip
}
