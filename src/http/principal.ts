import type { FastifyRequest } from 'fastify'
import type { AccountService, SessionPrincipal, UserRole } from '../accounts/service.js'
import type { AuthService, Principal } from '../auth/service.js'
import { forbidden, unauthorized } from '../errors.js'

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

export async function requireSession(
  request: FastifyRequest,
  accounts: AccountService,
  roles?: readonly UserRole[],
): Promise<SessionPrincipal> {
  const principal = await accounts.authenticateSession(bearerToken(request))
  if (roles !== undefined && !roles.includes(principal.role)) throw forbidden('role not allowed')
  return principal
}

/** 门户允许学员登录；后台仍要求 operator/admin，不能共用这个入口。 */
export function requirePortalSession(
  request: FastifyRequest,
  accounts: AccountService,
): Promise<SessionPrincipal> {
  return accounts.authenticateSession(bearerToken(request), { allowStudent: true })
}

export function clientIp(request: FastifyRequest): string {
  return request.ip
}
