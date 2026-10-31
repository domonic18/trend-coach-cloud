import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { badRequest, tooManyRequests } from '../errors.js'
import { clientIp, requireSession } from '../http/principal.js'
import { asObject, optionalStringField, stringField } from '../http/validation.js'
import type { RateLimiter } from '../rate-limit.js'
import { USER_ROLES, USER_STATUSES, type AccountService, type UserRole, type UserStatus } from './service.js'

const USERNAME = /^[a-z][a-z0-9._-]{2,31}$/
const PASSWORD_MIN = 10
const PASSWORD_MAX = 128

export interface AccountRouteDeps {
  accounts: AccountService
  config: AppConfig
  limiter: RateLimiter
}

function usernameField(body: Record<string, unknown>): string {
  return stringField(body, 'username', { min: 3, max: 32, pattern: USERNAME })
}

function passwordField(body: Record<string, unknown>, key = 'password'): string {
  return stringField(body, key, { min: PASSWORD_MIN, max: PASSWORD_MAX })
}

function optionalPassword(body: Record<string, unknown>): string | undefined {
  if (body.password === undefined) return undefined
  return passwordField(body)
}

function roleValue(value: unknown): UserRole {
  if (typeof value !== 'string' || !(USER_ROLES as readonly string[]).includes(value)) {
    throw badRequest(`role must be ${USER_ROLES.join('/')}`)
  }
  return value as UserRole
}

function statusValue(value: unknown): UserStatus {
  if (typeof value !== 'string' || !(USER_STATUSES as readonly string[]).includes(value)) {
    throw badRequest(`status must be ${USER_STATUSES.join('/')}`)
  }
  return value as UserStatus
}

function queryObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function queryInt(query: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const raw = query[key]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps): void {
  const { accounts, config, limiter } = deps

  app.post('/v1/auth/invite/redeem', async request => {
    if (!limiter.take(`invite:${clientIp(request)}`, config.rateLimitInvitePerMinute)) {
      throw tooManyRequests()
    }
    const body = asObject(request.body)
    const inviteCode = stringField(body, 'inviteCode', { max: 32 })
    const password = passwordField(body)
    await accounts.redeemInvite(inviteCode, password)
    return { redeemed: true }
  })

  app.post('/v1/auth/session', async request => {
    if (!limiter.take(`login:${clientIp(request)}`, config.rateLimitLoginPerMinute)) {
      throw tooManyRequests()
    }
    const body = asObject(request.body)
    const username = usernameField(body)
    const password = stringField(body, 'password', { max: PASSWORD_MAX })
    return accounts.login(username, password)
  })

  app.get('/v1/auth/session', async request => {
    const principal = await requireSession(request, accounts)
    return {
      user: {
        userId: principal.userId,
        username: principal.username,
        displayName: principal.displayName,
        role: principal.role,
      },
    }
  })

  app.delete('/v1/auth/session', async request => {
    const principal = await requireSession(request, accounts)
    await accounts.revokeSession(principal.tokenHash)
    return { revoked: true }
  })

  app.post('/v1/auth/session/password', async request => {
    const principal = await requireSession(request, accounts)
    const body = asObject(request.body)
    const currentPassword = stringField(body, 'currentPassword', { max: PASSWORD_MAX })
    const newPassword = passwordField(body, 'newPassword')
    await accounts.changePassword(principal.userId, currentPassword, newPassword)
    return { updated: true }
  })

  app.get('/v1/admin/users', async request => {
    await requireSession(request, accounts, ['operator', 'admin'])
    const query = queryObject(request.query)
    const search = query.query === undefined
      ? undefined
      : stringField({ query: query.query }, 'query', { max: 100 })
    return accounts.listUsers({
      ...(search === undefined ? {} : { query: search }),
      ...(query.role === undefined ? {} : { role: roleValue(query.role) }),
      ...(query.status === undefined ? {} : { status: statusValue(query.status) }),
      offset: queryInt(query, 'offset', 0, 0, 100_000),
      limit: queryInt(query, 'limit', 50, 1, 100),
    })
  })

  app.post('/v1/admin/users', async (request, reply) => {
    const actor = await requireSession(request, accounts, ['admin'])
    const body = asObject(request.body)
    const created = await accounts.createUser({
      username: usernameField(body),
      displayName: stringField(body, 'displayName', { min: 1, max: 200 }),
      role: roleValue(body.role),
      ...(body.password === undefined ? {} : { password: passwordField(body) }),
    }, actor.userId)
    return reply.code(201).send(created)
  })

  app.patch('/v1/admin/users/:userId', async request => {
    const actor = await requireSession(request, accounts, ['admin'])
    const userId = (request.params as { userId: string }).userId
    const body = asObject(request.body)
    const displayName = optionalStringField(body, 'displayName', { min: 1, max: 200 })
    const role = body.role === undefined ? undefined : roleValue(body.role)
    const status = body.status === undefined ? undefined : statusValue(body.status)
    if (displayName === undefined && role === undefined && status === undefined) {
      throw badRequest('at least one of displayName, role, status is required')
    }
    const user = await accounts.patchUser(actor, userId, {
      ...(displayName === undefined ? {} : { displayName }),
      ...(role === undefined ? {} : { role }),
      ...(status === undefined ? {} : { status }),
    })
    return { user }
  })

  app.post('/v1/admin/users/:userId/reset', async request => {
    const actor = await requireSession(request, accounts, ['admin'])
    const userId = (request.params as { userId: string }).userId
    const body = request.body === undefined ? {} : asObject(request.body)
    return accounts.resetCredentials(actor, userId, optionalPassword(body))
  })
}
