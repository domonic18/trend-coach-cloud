import type { Pool, PoolClient } from 'pg'
import type { AppConfig } from '../config.js'
import { withTransaction } from '../db.js'
import { badRequest, forbidden, notFound, unauthorized } from '../errors.js'
import { hashToken, randomToken } from './tokens.js'

export const CLIENT_ID = 'dsh-plugin-trend-coach'

const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export interface Grant {
  accessToken: string
  refreshToken: string
  expiresAt: number
  deviceId: string
}

export interface Principal {
  userId: string
  deviceId: string
}

export interface DeviceCodeStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type DevicePoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'authorized'; grant: Grant }

function makeUserCode(): string {
  const pick = (): string => USER_CODE_ALPHABET[Math.floor(Math.random() * USER_CODE_ALPHABET.length)] ?? 'X'
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

interface DeviceCodeRow {
  device_code_hash: string
  user_code: string
  device_id: string
  user_id: string | null
  expires_at: Date
  approved_at: Date | null
  consumed_at: Date | null
}

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  async startDeviceCode(deviceId: string, clientId: string): Promise<DeviceCodeStart> {
    if (clientId !== CLIENT_ID) throw badRequest('clientId invalid')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const deviceCode = randomToken()
      const userCode = makeUserCode()
      try {
        await this.pool.query(
          `INSERT INTO device_codes (device_code_hash, user_code, device_id, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [hashToken(deviceCode), userCode, deviceId, new Date(Date.now() + this.config.deviceCodeTtlSec * 1000)],
        )
        return {
          deviceCode,
          userCode,
          verificationUri: `${this.config.publicBaseUrl}/device?code=${encodeURIComponent(userCode)}`,
          expiresIn: this.config.deviceCodeTtlSec,
          interval: this.config.devicePollIntervalSec,
        }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
      }
    }
    throw new Error('could not allocate a device code')
  }

  async approveDeviceCode(input: { userCode: string; userId?: string; displayName?: string }): Promise<void> {
    const userCode = input.userCode.trim().toUpperCase()
    await withTransaction(this.pool, async client => {
      const { rows } = await client.query<DeviceCodeRow>(
        `SELECT device_code_hash, user_code, device_id, user_id, expires_at, approved_at, consumed_at
         FROM device_codes WHERE user_code = $1 FOR UPDATE`,
        [userCode],
      )
      const code = rows[0]
      if (code === undefined || code.consumed_at !== null || code.expires_at.getTime() <= Date.now()) {
        throw notFound('device code invalid or expired')
      }
      const userId = await this.resolveUser(client, code, input)
      await client.query(
        `INSERT INTO devices (device_id, user_id) VALUES ($1, $2)
         ON CONFLICT (device_id) DO UPDATE SET user_id = EXCLUDED.user_id, status = 'active'`,
        [code.device_id, userId],
      )
      await client.query(
        'UPDATE device_codes SET user_id = $2, approved_at = now() WHERE device_code_hash = $1',
        [code.device_code_hash, userId],
      )
    })
  }

  private async resolveUser(
    client: PoolClient,
    code: DeviceCodeRow,
    input: { userId?: string; displayName?: string },
  ): Promise<string> {
    if (input.userId !== undefined) {
      const { rowCount } = await client.query(
        "SELECT 1 FROM users WHERE user_id = $1 AND status = 'active'",
        [input.userId],
      )
      if (rowCount === 0) throw badRequest('userId unknown or disabled')
      return input.userId
    }
    if (code.user_id !== null) return code.user_id
    const existing = await client.query<{ user_id: string }>(
      'SELECT user_id FROM devices WHERE device_id = $1',
      [code.device_id],
    )
    if (existing.rows[0] !== undefined) return existing.rows[0].user_id
    const userId = `usr_${randomToken(8)}`
    await client.query(
      'INSERT INTO users (user_id, display_name) VALUES ($1, $2)',
      [userId, input.displayName ?? null],
    )
    return userId
  }

  async pollDeviceToken(deviceCode: string): Promise<DevicePoll> {
    return withTransaction(this.pool, async client => {
      const { rows } = await client.query<DeviceCodeRow>(
        `SELECT device_code_hash, user_code, device_id, user_id, expires_at, approved_at, consumed_at
         FROM device_codes WHERE device_code_hash = $1 FOR UPDATE`,
        [hashToken(deviceCode)],
      )
      const code = rows[0]
      if (code === undefined || code.consumed_at !== null) return { status: 'expired' } as const
      if (code.expires_at.getTime() <= Date.now()) return { status: 'expired' } as const
      if (code.approved_at === null || code.user_id === null) return { status: 'pending' } as const
      await client.query('UPDATE device_codes SET consumed_at = now() WHERE device_code_hash = $1', [code.device_code_hash])
      const grant = await this.issueGrant(client, code.device_id, code.user_id)
      return { status: 'authorized', grant } as const
    })
  }

  private async issueGrant(
    client: PoolClient,
    deviceId: string,
    userId: string,
    rotatedFrom?: string,
  ): Promise<Grant> {
    const accessToken = randomToken()
    const refreshToken = randomToken()
    const accessExpiresAt = new Date(Date.now() + this.config.accessTtlSec * 1000)
    const refreshExpiresAt = new Date(Date.now() + this.config.refreshTtlSec * 1000)
    await client.query(
      `INSERT INTO tokens (token_hash, kind, device_id, user_id, expires_at, rotated_from)
       VALUES ($1, 'access', $2, $3, $4, NULL), ($5, 'refresh', $2, $3, $6, $7)`,
      [hashToken(accessToken), deviceId, userId, accessExpiresAt, hashToken(refreshToken), refreshExpiresAt, rotatedFrom ?? null],
    )
    return { accessToken, refreshToken, expiresAt: accessExpiresAt.getTime(), deviceId }
  }

  async refresh(refreshToken: string, deviceId: string): Promise<Grant> {
    // 重放处理必须在提交后再抛错，否则吊销会被同一事务回滚。
    const outcome = await withTransaction(this.pool, async client => {
      const { rows } = await client.query<{
        token_hash: string
        device_id: string
        user_id: string
        expires_at: Date
        revoked_at: Date | null
      }>(
        `SELECT token_hash, device_id, user_id, expires_at, revoked_at
         FROM tokens WHERE token_hash = $1 AND kind = 'refresh' FOR UPDATE`,
        [hashToken(refreshToken)],
      )
      const token = rows[0]
      if (token === undefined) return { kind: 'invalid' } as const
      if (token.device_id !== deviceId) return { kind: 'mismatch' } as const
      if (token.revoked_at !== null) {
        // 已轮换的 refresh 再次出现，按令牌泄露处理，吊销该设备全部令牌。
        await client.query(
          'UPDATE tokens SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL',
          [token.device_id],
        )
        return { kind: 'reused' } as const
      }
      if (token.expires_at.getTime() <= Date.now()) return { kind: 'expired' } as const
      await client.query('UPDATE tokens SET revoked_at = now() WHERE token_hash = $1', [token.token_hash])
      return { kind: 'ok', grant: await this.issueGrant(client, token.device_id, token.user_id, token.token_hash) } as const
    })
    switch (outcome.kind) {
      case 'ok':
        return outcome.grant
      case 'invalid':
      case 'expired':
        throw unauthorized(`refresh token ${outcome.kind}`)
      case 'reused':
        throw unauthorized('refresh token already used')
      case 'mismatch':
        throw forbidden('device mismatch')
    }
  }

  async authenticate(token: string, deviceId: string | undefined): Promise<Principal> {
    const { rows } = await this.pool.query<{
      user_id: string
      device_id: string
      expires_at: Date
      revoked_at: Date | null
      user_status: string
      device_status: string
    }>(
      `SELECT t.user_id, t.device_id, t.expires_at, t.revoked_at, u.status AS user_status, d.status AS device_status
       FROM tokens t
       JOIN users u ON u.user_id = t.user_id
       JOIN devices d ON d.device_id = t.device_id
       WHERE t.token_hash = $1 AND t.kind = 'access'`,
      [hashToken(token)],
    )
    const row = rows[0]
    if (row === undefined || row.revoked_at !== null || row.expires_at.getTime() <= Date.now()) {
      throw unauthorized()
    }
    if (row.user_status !== 'active' || row.device_status !== 'active') throw unauthorized('account disabled')
    if (deviceId === undefined || deviceId !== row.device_id) throw forbidden('device mismatch')
    return { userId: row.user_id, deviceId: row.device_id }
  }

  async watermarkLabel(userId: string): Promise<string> {
    const { rows } = await this.pool.query<{ display_name: string | null }>(
      'SELECT display_name FROM users WHERE user_id = $1',
      [userId],
    )
    return rows[0]?.display_name ?? `学员 ${userId.slice(-6)}`
  }

  async eventsConsent(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ events_consent: boolean }>(
      'SELECT events_consent FROM users WHERE user_id = $1',
      [userId],
    )
    return rows[0]?.events_consent ?? false
  }
}
