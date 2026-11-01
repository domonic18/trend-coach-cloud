import type {
  PortalDevice,
  PortalProfile,
  PortalStats,
  PortalUser,
  ReleaseManifest,
  SessionResult,
} from './types'

const TOKEN_KEY = 'trend-coach-portal-token'

function readStoredToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

let token: string | null = readStoredToken()

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()

export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

function notifyUnauthorized(): void {
  clearToken()
  for (const listener of unauthorizedListeners) listener()
}

export function hasToken(): boolean {
  return token !== null
}

export function clearToken(): void {
  token = null
  try {
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // 隐私模式下读写失败不影响本次会话
  }
}

function saveToken(value: string): void {
  token = value
  try {
    sessionStorage.setItem(TOKEN_KEY, value)
  } catch {
    // 同上：写不进去时本次会话仍可用内存中的 token
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  const response = await fetch(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized()
    const message = typeof payload === 'object' && payload !== null
      && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `请求失败（${response.status}）`
    throw new ApiError(response.status, message)
  }
  return payload as T
}

export async function register(input: {
  username: string
  password: string
  displayName?: string
}): Promise<SessionResult> {
  const session = await request<SessionResult>('POST', '/v1/portal/auth/register', input)
  saveToken(session.token)
  return session
}

export async function login(username: string, password: string): Promise<SessionResult> {
  const session = await request<SessionResult>('POST', '/v1/portal/auth/login', { username, password })
  saveToken(session.token)
  return session
}

export async function currentUser(): Promise<PortalUser> {
  return (await request<{ user: PortalProfile }>('GET', '/v1/portal/auth/session')).user
}

export async function logout(): Promise<void> {
  try {
    await request<{ revoked: boolean }>('DELETE', '/v1/portal/auth/session')
  } finally {
    clearToken()
  }
}

export async function getProfile(): Promise<PortalProfile> {
  return (await request<{ profile: PortalProfile }>('GET', '/v1/portal/me')).profile
}

export async function updateDisplayName(displayName: string): Promise<PortalProfile> {
  return (await request<{ profile: PortalProfile }>('PATCH', '/v1/portal/me', { displayName })).profile
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request('POST', '/v1/portal/me/password', { currentPassword, newPassword })
}

export async function listDevices(): Promise<PortalDevice[]> {
  return (await request<{ devices: PortalDevice[] }>('GET', '/v1/portal/me/devices')).devices
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await request('DELETE', `/v1/portal/me/devices/${encodeURIComponent(deviceId)}`)
}

export async function getReleases(): Promise<ReleaseManifest> {
  return request<ReleaseManifest>('GET', '/v1/portal/releases')
}

export async function getStats(): Promise<PortalStats> {
  return request<PortalStats>('GET', '/v1/portal/stats')
}
