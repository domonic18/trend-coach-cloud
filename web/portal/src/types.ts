export interface PortalUser {
  userId: string
  username: string
  displayName: string | null
  role: string
}

export interface PortalProfile extends PortalUser {
  status: string
  createdAt: number
  passwordUpdatedAt: number | null
  deviceCount: number
}

export interface SessionResult {
  token: string
  expiresAt: number
  user: PortalUser
}

export interface PortalDevice {
  deviceId: string
  status: 'active' | 'revoked'
  firstAuthorizedAt: number
  lastSeenAt: number
}

export interface ReleaseManifest {
  dshVersion: string
  webAppPackage: string
  plugin: {
    name: string
    version: string
    fileName: string
    sha256: string | null
    sizeBytes: number | null
    publishedAt: string
    notes: string[]
  } | null
}

export interface PortalStats {
  courses: number
  knowledgePoints: number
  segments: number
  articles: number
}
