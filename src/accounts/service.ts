import type { Pool, PoolClient } from 'pg'
import { hashToken, randomToken } from '../auth/tokens.js'
import type { AppConfig } from '../config.js'
import { withTransaction } from '../db.js'
import { conflict, forbidden, notFound, unauthorized } from '../errors.js'
import { hashPassword, verifyPassword } from './password.js'

export const USER_ROLES = ['student', 'operator', 'admin'] as const
export type UserRole = (typeof USER_ROLES)[number]

export const USER_STATUSES = ['active', 'disabled'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export interface AdminUser {
  userId: string
  username: string | null
  displayName: string | null
  role: UserRole
  status: UserStatus
  deviceCount: number
  createdAt: number
  lastActiveAt: number | null
}

export interface SessionUser {
  userId: string
  username: string
  displayName: string | null
  role: UserRole
}

export interface SessionPrincipal extends SessionUser {
  tokenHash: string
}

export interface SessionResult {
  token: string
  expiresAt: number
  user: SessionUser
}

interface UserRow {
  user_id: string
  username: string | null
  display_name: string | null
  role: UserRole
  status: UserStatus
  password_hash: string | null
}

interface UserListRow extends UserRow {
  created_at: Date
  device_count: number
  last_active_at: Date | null
}

function makeInviteCode(): string {
  const pick = (): string => INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)] ?? 'X'
  const group = (): string => `${pick()}${pick()}${pick()}${pick()}`
  return `${group()}-${group()}-${group()}-${group()}`
}

function normalizeInviteCode(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase()
}

function isInviteCode(value: string): boolean {
  return value.length === 16 && [...value].every(character => INVITE_ALPHABET.includes(character))
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`)
}

function toAdminUser(row: UserListRow): AdminUser {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    deviceCount: Number(row.device_count),
    createdAt: row.created_at.getTime(),
    lastActiveAt: row.last_active_at?.getTime() ?? null,
  }
}

function toSessionUser(row: UserRow): SessionUser {
  return {
    userId: row.user_id,
    username: row.username ?? row.user_id,
    displayName: row.display_name,
    role: row.role,
  }
}

let dummyHashPromise: Promise<string> | undefined

async function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomToken(16))
  return dummyHashPromise
}

export class AccountService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  async bootstrapAdmin(): Promise<{ created: boolean; reason?: string }> {
    const bootstrap = this.config.bootstrapAdmin
    if (bootstrap === undefined) return { created: false, reason: 'not-configured' }
    return withTransaction(this.pool, async client => {
      const { rowCount } = await client.query(
        "SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1",
      )
      if ((rowCount ?? 0) > 0) return { created: false, reason: 'admin-exists' }
      const existing = await client.query('SELECT 1 FROM users WHERE username = $1', [bootstrap.username])
      if ((existing.rowCount ?? 0) > 0) {
        throw new Error(`BOOTSTRAP_ADMIN_USERNAME ${bootstrap.username} 已存在但不是 active admin`)
      }
      await client.query(
        `INSERT INTO users (user_id, username, display_name, role, password_hash, password_updated_at)
         VALUES ($1, $2, $3, 'admin', $4, now())`,
        [`usr_${randomToken(8)}`, bootstrap.username, '管理员', await hashPassword(bootstrap.password)],
      )
      return { created: true }
    })
  }

  async login(username: string, password: string): Promise<SessionResult> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT user_id, username, display_name, role, status, password_hash
       FROM users WHERE username = $1`,
      [username],
    )
    const row = rows[0]
    if (row === undefined) {
      await verifyPassword(password, await dummyHash())
      throw unauthorized('invalid credentials')
    }
    if (!(await verifyPassword(password, row.password_hash))) throw unauthorized('invalid credentials')
    if (row.status !== 'active' || row.password_hash === null) throw unauthorized('account disabled or not activated')
    if (row.role === 'student') throw forbidden('console access requires operator role')
    return this.issueSession(row)
  }

  private async issueSession(row: UserRow): Promise<SessionResult> {
    const token = randomToken()
    const expiresAt = Date.now() + this.config.sessionTtlSec * 1000
    await this.pool.query(
      'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [hashToken(token), row.user_id, new Date(expiresAt)],
    )
    return { token, expiresAt, user: { ...toSessionUser(row), role: row.role } }
  }

  async authenticateSession(token: string): Promise<SessionPrincipal> {
    const tokenHash = hashToken(token)
    const { rows } = await this.pool.query<UserRow & { expires_at: Date; revoked_at: Date | null }>(
      `SELECT s.expires_at, s.revoked_at,
              u.user_id, u.username, u.display_name, u.role, u.status, u.password_hash
       FROM sessions s JOIN users u ON u.user_id = s.user_id
       WHERE s.token_hash = $1`,
      [tokenHash],
    )
    const row = rows[0]
    if (row === undefined || row.revoked_at !== null || row.expires_at.getTime() <= Date.now()) {
      throw unauthorized('session invalid or expired')
    }
    if (row.status !== 'active') throw unauthorized('account disabled')
    if (row.role === 'student') throw forbidden('console access requires operator role')
    await this.pool.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [tokenHash])
    return { ...toSessionUser(row), role: row.role, tokenHash }
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash])
  }

  async verifyCredentials(username: string, password: string): Promise<string> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT user_id, username, display_name, role, status, password_hash
       FROM users WHERE username = $1`,
      [username],
    )
    const row = rows[0]
    if (row === undefined) {
      await verifyPassword(password, await dummyHash())
      throw unauthorized('invalid credentials')
    }
    if (!(await verifyPassword(password, row.password_hash))) throw unauthorized('invalid credentials')
    if (row.status !== 'active' || row.password_hash === null) throw unauthorized('account disabled or not activated')
    return row.user_id
  }

  async redeemInvite(inviteCode: string, password: string): Promise<string> {
    const normalized = normalizeInviteCode(inviteCode)
    if (!isInviteCode(normalized)) throw unauthorized('invite code invalid or expired')
    return withTransaction(this.pool, async client => {
      const { rows } = await client.query<{ user_id: string; status: UserStatus }>(
        `SELECT i.user_id, u.status
         FROM invite_codes i JOIN users u ON u.user_id = i.user_id
         WHERE i.code_hash = $1 AND i.consumed_at IS NULL AND i.expires_at > now()
         FOR UPDATE`,
        [hashToken(normalized)],
      )
      const invite = rows[0]
      if (invite === undefined) throw unauthorized('invite code invalid or expired')
      if (invite.status !== 'active') throw unauthorized('account disabled')
      await client.query(
        'UPDATE users SET password_hash = $2, password_updated_at = now() WHERE user_id = $1',
        [invite.user_id, await hashPassword(password)],
      )
      await client.query('UPDATE invite_codes SET consumed_at = now() WHERE code_hash = $1', [hashToken(normalized)])
      await this.revokeUserSessions(client, invite.user_id)
      return invite.user_id
    })
  }

  async createUser(
    input: { username: string; displayName: string; role: UserRole; password?: string },
    createdBy: string,
  ): Promise<{ user: AdminUser; inviteCode?: string; inviteExpiresAt?: number }> {
    return withTransaction(this.pool, async client => {
      const userId = `usr_${randomToken(8)}`
      let row: UserListRow
      try {
        const { rows } = await client.query<UserListRow>(
          `INSERT INTO users (user_id, username, display_name, role, password_hash, password_updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING user_id, username, display_name, role, status, password_hash, created_at,
                     0 AS device_count, NULL::timestamptz AS last_active_at`,
          [
            userId,
            input.username,
            input.displayName,
            input.role,
            input.password === undefined ? null : await hashPassword(input.password),
            input.password === undefined ? null : new Date(),
          ],
        )
        row = rows[0] as UserListRow
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('username already exists')
        throw error
      }
      if (input.password !== undefined) return { user: toAdminUser(row) }
      const invite = await this.createInvite(client, userId, createdBy)
      return { user: toAdminUser(row), ...invite }
    })
  }

  private async createInvite(
    client: PoolClient,
    userId: string,
    createdBy: string | null,
  ): Promise<{ inviteCode: string; inviteExpiresAt: number }> {
    await client.query(
      'UPDATE invite_codes SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL',
      [userId],
    )
    const expiresAt = new Date(Date.now() + this.config.inviteTtlSec * 1000)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const inviteCode = makeInviteCode()
      try {
        await client.query(
          'INSERT INTO invite_codes (code_hash, user_id, expires_at, created_by) VALUES ($1, $2, $3, $4)',
          [hashToken(normalizeInviteCode(inviteCode)), userId, expiresAt, createdBy],
        )
        return { inviteCode, inviteExpiresAt: expiresAt.getTime() }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
      }
    }
    throw new Error('could not allocate an invite code')
  }

  async listUsers(filters: {
    query?: string
    role?: UserRole
    status?: UserStatus
    offset: number
    limit: number
  }): Promise<{ users: AdminUser[]; total: number; offset: number; limit: number }> {
    const conditions: string[] = []
    const values: unknown[] = []
    if (filters.query !== undefined && filters.query.trim() !== '') {
      values.push(`%${escapeLike(filters.query.trim())}%`)
      conditions.push(`(u.username ILIKE $${values.length} ESCAPE '\\' OR u.display_name ILIKE $${values.length} ESCAPE '\\')`)
    }
    if (filters.role !== undefined) {
      values.push(filters.role)
      conditions.push(`u.role = $${values.length}`)
    }
    if (filters.status !== undefined) {
      values.push(filters.status)
      conditions.push(`u.status = $${values.length}`)
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const totalResult = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM users u ${where}`,
      values,
    )
    const pageValues = [...values, filters.limit, filters.offset]
    const { rows } = await this.pool.query<UserListRow>(
      `SELECT u.user_id, u.username, u.display_name, u.role, u.status, u.created_at,
              count(d.device_id)::int AS device_count, max(d.last_seen_at) AS last_active_at
       FROM users u LEFT JOIN devices d ON d.user_id = u.user_id
       ${where}
       GROUP BY u.user_id
       ORDER BY u.created_at DESC, u.user_id DESC
       LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues,
    )
    return {
      users: rows.map(toAdminUser),
      total: Number(totalResult.rows[0]?.total ?? 0),
      offset: filters.offset,
      limit: filters.limit,
    }
  }

  async patchUser(
    actor: SessionPrincipal,
    targetId: string,
    patch: { displayName?: string; role?: UserRole; status?: UserStatus },
  ): Promise<AdminUser> {
    return withTransaction(this.pool, async client => {
      const { rows } = await client.query<UserRow>(
        `SELECT user_id, username, display_name, role, status, password_hash
         FROM users WHERE user_id = $1 FOR UPDATE`,
        [targetId],
      )
      const target = rows[0]
      if (target === undefined) throw notFound('user not found')
      if (targetId === actor.userId && (patch.role !== undefined || patch.status !== undefined)) {
        throw forbidden('cannot change own role or status')
      }
      const removesAdmin = target.role === 'admin'
        && ((patch.role !== undefined && patch.role !== 'admin') || patch.status === 'disabled')
      if (removesAdmin) {
        const remaining = await client.query(
          "SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' AND user_id <> $1 LIMIT 1",
          [targetId],
        )
        if ((remaining.rowCount ?? 0) === 0) throw conflict('cannot remove the last active admin')
      }
      const assignments: string[] = []
      const values: unknown[] = []
      const push = (column: string, value: unknown): void => {
        values.push(value)
        assignments.push(`${column} = $${values.length}`)
      }
      if (patch.displayName !== undefined) push('display_name', patch.displayName)
      if (patch.role !== undefined && patch.role !== target.role) push('role', patch.role)
      if (patch.status !== undefined && patch.status !== target.status) push('status', patch.status)
      if (assignments.length > 0) {
        values.push(targetId)
        await client.query(`UPDATE users SET ${assignments.join(', ')} WHERE user_id = $${values.length}`, values)
      }
      if ((patch.role !== undefined && patch.role !== target.role) || patch.status === 'disabled') {
        await this.revokeUserSessions(client, targetId)
      }
      return this.getUser(client, targetId)
    })
  }

  async resetCredentials(
    actor: SessionPrincipal,
    targetId: string,
    password?: string,
  ): Promise<{ updated?: boolean; inviteCode?: string; inviteExpiresAt?: number }> {
    if (targetId === actor.userId) throw forbidden('use password change for your own account')
    return withTransaction(this.pool, async client => {
      const { rowCount } = await client.query('SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE', [targetId])
      if ((rowCount ?? 0) === 0) throw notFound('user not found')
      await this.revokeUserSessions(client, targetId)
      if (password !== undefined) {
        await client.query(
          'UPDATE users SET password_hash = $2, password_updated_at = now() WHERE user_id = $1',
          [targetId, await hashPassword(password)],
        )
        return { updated: true }
      }
      await client.query(
        'UPDATE users SET password_hash = NULL, password_updated_at = now() WHERE user_id = $1',
        [targetId],
      )
      return this.createInvite(client, targetId, actor.userId)
    })
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    await withTransaction(this.pool, async client => {
      const { rows } = await client.query<{ password_hash: string | null }>(
        'SELECT password_hash FROM users WHERE user_id = $1 FOR UPDATE',
        [userId],
      )
      const row = rows[0]
      if (row === undefined || !(await verifyPassword(currentPassword, row.password_hash))) {
        throw unauthorized('current password incorrect')
      }
      await client.query(
        'UPDATE users SET password_hash = $2, password_updated_at = now() WHERE user_id = $1',
        [userId, await hashPassword(newPassword)],
      )
      await this.revokeUserSessions(client, userId)
    })
  }

  private async revokeUserSessions(client: PoolClient, userId: string): Promise<void> {
    await client.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    )
  }

  private async getUser(client: PoolClient, userId: string): Promise<AdminUser> {
    const { rows } = await client.query<UserListRow>(
      `SELECT u.user_id, u.username, u.display_name, u.role, u.status, u.created_at,
              count(d.device_id)::int AS device_count, max(d.last_seen_at) AS last_active_at
       FROM users u LEFT JOIN devices d ON d.user_id = u.user_id
       WHERE u.user_id = $1
       GROUP BY u.user_id`,
      [userId],
    )
    const row = rows[0]
    if (row === undefined) throw notFound('user not found')
    return toAdminUser(row)
  }
}
