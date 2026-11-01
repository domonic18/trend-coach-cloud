import type {
  Article,
  AsrModelConfig,
  AsrProtocol,
  ContentStatus,
  Course,
  CoursePublishResult,
  CourseSummary,
  CourseTree,
  LlmModelConfig,
  LlmProtocol,
  LlmPurpose,
  ModelTestResult,
  GenerationApplyResult,
  GenerationPreview,
  GenerationSummary,
  MediaAsset,
  MediaAssetList,
  MediaAssetStatus,
  PipelineJob,
  PipelineJobDetail,
  PipelineJobKind,
  PipelineJobList,
  PipelineJobStatus,
  Segment,
  SegmentList,
  SessionResponse,
  SessionUser,
  TranscriptPage,
  User,
  UserList,
  UserRole,
  UserStatus,
} from './types'

const TOKEN_KEY = 'trend-coach-admin-token'

let token: string | null = sessionStorage.getItem(TOKEN_KEY)

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function hasToken(): boolean {
  return token !== null
}

export function clearToken(): void {
  token = null
  sessionStorage.removeItem(TOKEN_KEY)
}

function saveToken(value: string): void {
  token = value
  sessionStorage.setItem(TOKEN_KEY, value)
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
    if (response.status === 401) clearToken()
    const message = typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `请求失败（${response.status}）`
    throw new ApiError(response.status, message)
  }
  return payload as T
}

export async function login(username: string, password: string): Promise<SessionUser> {
  const session = await request<SessionResponse>('POST', '/v1/auth/session', { username, password })
  saveToken(session.token)
  return session.user
}

export async function currentUser(): Promise<SessionUser> {
  const body = await request<{ user: SessionUser }>('GET', '/v1/auth/session')
  return body.user
}

export async function logout(): Promise<void> {
  try {
    await request<{ revoked: boolean }>('DELETE', '/v1/auth/session')
  } finally {
    clearToken()
  }
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request('POST', '/v1/auth/session/password', { currentPassword, newPassword })
}

export async function listCourses(): Promise<CourseSummary[]> {
  return (await request<{ courses: CourseSummary[] }>('GET', '/v1/admin/content/courses')).courses
}

export async function createCourse(input: { courseId: string; title: string; status?: ContentStatus }): Promise<Course> {
  return (await request<{ course: Course }>('POST', '/v1/admin/content/courses', input)).course
}

export async function patchCourse(
  courseId: string,
  input: { title?: string; status?: ContentStatus },
): Promise<Course> {
  return (await request<{ course: Course }>('PATCH', `/v1/admin/content/courses/${encodeURIComponent(courseId)}`, input)).course
}

export async function getCourseTree(courseId: string): Promise<CourseTree> {
  return request<CourseTree>('GET', `/v1/admin/content/courses/${encodeURIComponent(courseId)}`)
}

export async function createChapter(
  courseId: string,
  input: { chapterId: string; title: string; position?: number },
): Promise<void> {
  await request('POST', `/v1/admin/content/courses/${encodeURIComponent(courseId)}/chapters`, input)
}

export async function patchChapter(
  courseId: string,
  chapterId: string,
  input: { title?: string; position?: number },
): Promise<void> {
  await request(
    'PATCH',
    `/v1/admin/content/courses/${encodeURIComponent(courseId)}/chapters/${encodeURIComponent(chapterId)}`,
    input,
  )
}

export async function createKnowledgePoint(
  courseId: string,
  chapterId: string,
  input: { knowledgePointId: string; title: string; position?: number },
): Promise<void> {
  await request(
    'POST',
    `/v1/admin/content/courses/${encodeURIComponent(courseId)}/chapters/${encodeURIComponent(chapterId)}/knowledge-points`,
    input,
  )
}

export async function patchKnowledgePoint(
  knowledgePointId: string,
  input: { title?: string; position?: number },
): Promise<void> {
  await request('PATCH', `/v1/admin/content/knowledge-points/${encodeURIComponent(knowledgePointId)}`, input)
}

export async function getArticle(knowledgePointId: string): Promise<Article | null> {
  return (await request<{ article: Article | null }>(
    'GET',
    `/v1/admin/content/knowledge-points/${encodeURIComponent(knowledgePointId)}/article`,
  )).article
}

export async function putArticle(
  knowledgePointId: string,
  input: { markdown: string; status: ContentStatus },
): Promise<Article> {
  return (await request<{ article: Article }>(
    'PUT',
    `/v1/admin/content/knowledge-points/${encodeURIComponent(knowledgePointId)}/article`,
    input,
  )).article
}

export async function listSegments(filters: {
  courseId?: string
  knowledgePointId?: string
  status?: ContentStatus
  query?: string
  offset?: number
  limit?: number
}): Promise<SegmentList> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const query = params.toString()
  return request<SegmentList>('GET', `/v1/admin/content/segments${query === '' ? '' : `?${query}`}`)
}

export async function createSegment(input: {
  segmentId: string
  courseId: string
  chapterId: string
  knowledgePointId: string
  title: string
  startSec: number
  endSec: number
  text: string
  status?: ContentStatus
}): Promise<Segment> {
  return (await request<{ segment: Segment }>('POST', '/v1/admin/content/segments', input)).segment
}

export async function patchSegment(
  segmentId: string,
  input: {
    title?: string
    startSec?: number
    endSec?: number
    text?: string
    status?: ContentStatus
  },
): Promise<Segment> {
  return (await request<{ segment: Segment }>(
    'PATCH',
    `/v1/admin/content/segments/${encodeURIComponent(segmentId)}`,
    input,
  )).segment
}

export async function reindex(courseId?: string): Promise<number> {
  return (await request<{ embedded: number }>(
    'POST',
    '/v1/admin/content/reindex',
    courseId === undefined ? {} : { courseId },
  )).embedded
}

export async function listUsers(filters: {
  query?: string
  role?: UserRole
  status?: UserStatus
  offset?: number
  limit?: number
}): Promise<UserList> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const query = params.toString()
  return request<UserList>('GET', `/v1/admin/users${query === '' ? '' : `?${query}`}`)
}

export async function createUser(input: {
  username: string
  displayName: string
  role: UserRole
  password?: string
}): Promise<{ user: User; inviteCode?: string; inviteExpiresAt?: number }> {
  return request('POST', '/v1/admin/users', input)
}

export async function patchUser(
  userId: string,
  input: { displayName?: string; role?: UserRole; status?: UserStatus },
): Promise<User> {
  return (await request<{ user: User }>('PATCH', `/v1/admin/users/${encodeURIComponent(userId)}`, input)).user
}

export async function resetUser(
  userId: string,
  password?: string,
): Promise<{ updated: boolean; inviteCode?: string; inviteExpiresAt?: number }> {
  return request('POST', `/v1/admin/users/${encodeURIComponent(userId)}/reset`, password === undefined ? {} : { password })
}

export async function listMediaAssets(filters: {
  courseId?: string
  status?: MediaAssetStatus
  offset?: number
  limit?: number
}): Promise<MediaAssetList> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const query = params.toString()
  return request<MediaAssetList>('GET', `/v1/admin/content/media-assets${query === '' ? '' : `?${query}`}`)
}

export async function createMediaAsset(input: { courseId: string; title: string }): Promise<MediaAsset> {
  return (await request<{ asset: MediaAsset }>('POST', '/v1/admin/content/media-assets', input)).asset
}

export async function patchMediaAsset(
  assetId: string,
  input: { title?: string; status?: 'archived' },
): Promise<MediaAsset> {
  return (await request<{ asset: MediaAsset }>(
    'PATCH',
    `/v1/admin/content/media-assets/${encodeURIComponent(assetId)}`,
    input,
  )).asset
}

/** 大文件走 XHR 才能拿上传进度；令牌放请求头，不进 URL。 */
export function uploadMediaSource(
  assetId: string,
  file: File,
  onProgress?: (ratio: number) => void,
): Promise<MediaAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/v1/admin/content/media-assets/${encodeURIComponent(assetId)}/source`)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    if (token !== null) xhr.setRequestHeader('authorization', `Bearer ${token}`)
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total)
    }
    xhr.onerror = () => reject(new ApiError(0, '上传失败，请检查网络'))
    xhr.onload = () => {
      let payload: unknown
      try {
        payload = JSON.parse(xhr.responseText)
      } catch {
        payload = undefined
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((payload as { asset: MediaAsset }).asset)
        return
      }
      if (xhr.status === 401) clearToken()
      const message = typeof payload === 'object' && payload !== null
        && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `上传失败（${xhr.status}）`
      reject(new ApiError(xhr.status, message))
    }
    xhr.send(file)
  })
}

export async function enqueueIngest(assetId: string, language: 'zh' | 'en' | 'auto'): Promise<PipelineJob> {
  return (await request<{ job: PipelineJob }>(
    'POST',
    `/v1/admin/content/media-assets/${encodeURIComponent(assetId)}/ingest`,
    { language },
  )).job
}

export async function getTranscript(
  assetId: string,
  page: { offset?: number; limit?: number } = {},
): Promise<TranscriptPage> {
  const params = new URLSearchParams()
  if (page.offset !== undefined) params.set('offset', String(page.offset))
  if (page.limit !== undefined) params.set('limit', String(page.limit))
  const query = params.toString()
  return request<TranscriptPage>(
    'GET',
    `/v1/admin/content/media-assets/${encodeURIComponent(assetId)}/transcript${query === '' ? '' : `?${query}`}`,
  )
}

export async function listPipelineJobs(filters: {
  status?: PipelineJobStatus
  kind?: PipelineJobKind
  courseId?: string
  assetId?: string
  offset?: number
  limit?: number
}): Promise<PipelineJobList> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const query = params.toString()
  return request<PipelineJobList>('GET', `/v1/admin/content/pipeline/jobs${query === '' ? '' : `?${query}`}`)
}

export async function getPipelineJob(jobId: string): Promise<PipelineJobDetail> {
  return (await request<{ job: PipelineJobDetail }>(
    'GET',
    `/v1/admin/content/pipeline/jobs/${encodeURIComponent(jobId)}`,
  )).job
}

export async function retryPipelineJob(jobId: string): Promise<PipelineJob> {
  return (await request<{ job: PipelineJob }>(
    'POST',
    `/v1/admin/content/pipeline/jobs/${encodeURIComponent(jobId)}/retry`,
  )).job
}

export async function cancelPipelineJob(jobId: string): Promise<PipelineJob> {
  return (await request<{ job: PipelineJob }>(
    'POST',
    `/v1/admin/content/pipeline/jobs/${encodeURIComponent(jobId)}/cancel`,
  )).job
}

export async function enqueueGeneration(assetId: string): Promise<PipelineJob> {
  return (await request<{ job: PipelineJob }>(
    'POST',
    `/v1/admin/content/media-assets/${encodeURIComponent(assetId)}/generations`,
  )).job
}

export async function getGeneration(generationId: string): Promise<GenerationPreview> {
  return request<GenerationPreview>(
    'GET',
    `/v1/admin/content/generations/${encodeURIComponent(generationId)}`,
  )
}

export async function applyGeneration(generationId: string): Promise<GenerationApplyResult> {
  return request<GenerationApplyResult>(
    'POST',
    `/v1/admin/content/generations/${encodeURIComponent(generationId)}/apply`,
  )
}

export async function discardGeneration(generationId: string): Promise<GenerationSummary> {
  return (await request<{ generation: GenerationSummary }>(
    'POST',
    `/v1/admin/content/generations/${encodeURIComponent(generationId)}/discard`,
  )).generation
}

export async function publishCourse(courseId: string): Promise<CoursePublishResult> {
  return request<CoursePublishResult>(
    'POST',
    `/v1/admin/content/courses/${encodeURIComponent(courseId)}/publish`,
  )
}

export interface LlmConfigInput {
  name: string
  provider: string
  protocol?: LlmProtocol
  baseUrl: string
  model: string
  purpose: LlmPurpose
  apiKey?: string
  isDefault?: boolean
  isActive?: boolean
}

export async function listLlmConfigs(): Promise<LlmModelConfig[]> {
  return request<LlmModelConfig[]>('GET', '/v1/admin/model-configs/llm')
}

export async function createLlmConfig(input: LlmConfigInput): Promise<LlmModelConfig> {
  return request<LlmModelConfig>('POST', '/v1/admin/model-configs/llm', input)
}

export async function patchLlmConfig(
  configId: string,
  input: Partial<LlmConfigInput>,
): Promise<LlmModelConfig> {
  return request<LlmModelConfig>(
    'PATCH',
    `/v1/admin/model-configs/llm/${encodeURIComponent(configId)}`,
    input,
  )
}

export async function deleteLlmConfig(configId: string): Promise<void> {
  await request<undefined>('DELETE', `/v1/admin/model-configs/llm/${encodeURIComponent(configId)}`)
}

export async function setDefaultLlmConfig(configId: string): Promise<LlmModelConfig> {
  return request<LlmModelConfig>(
    'POST',
    `/v1/admin/model-configs/llm/${encodeURIComponent(configId)}/set-default`,
  )
}

export async function testLlmConfig(configId: string): Promise<ModelTestResult> {
  return request<ModelTestResult>(
    'POST',
    `/v1/admin/model-configs/llm/${encodeURIComponent(configId)}/test`,
  )
}

export async function getAsrConfig(): Promise<AsrModelConfig> {
  return request<AsrModelConfig>('GET', '/v1/admin/model-configs/asr')
}

export async function patchAsrConfig(input: {
  provider?: string
  protocol?: AsrProtocol
  baseUrl?: string
  model?: string
  apiKey?: string
  enabled?: boolean
}): Promise<AsrModelConfig> {
  return request<AsrModelConfig>('PATCH', '/v1/admin/model-configs/asr', input)
}

export async function testAsrConfig(): Promise<ModelTestResult> {
  return request<ModelTestResult>('POST', '/v1/admin/model-configs/asr/test')
}
