export type ContentStatus = 'draft' | 'published' | 'archived'
export type UserRole = 'student' | 'operator' | 'admin'
export type UserStatus = 'active' | 'disabled'

export interface SessionUser {
  userId: string
  username: string
  displayName: string | null
  role: UserRole
}

export interface SessionResponse {
  token: string
  expiresAt: number
  user: SessionUser
}

export interface Course {
  courseId: string
  title: string
  status: ContentStatus
}

export interface CourseSummary extends Course {
  chapterCount: number
  knowledgePointCount: number
  segmentCount: number
  articleCount: number
}

export interface ArticleMeta {
  version: number
  status: ContentStatus
  publishedAt: number | null
}

export interface Article extends ArticleMeta {
  markdown: string
}

export interface KnowledgePoint {
  knowledgePointId: string
  title: string
  position: number
  segmentCount: number
  article: ArticleMeta | null
}

export interface Chapter {
  chapterId: string
  title: string
  position: number
  knowledgePoints: KnowledgePoint[]
}

export interface CourseTree {
  course: Course
  chapters: Chapter[]
}

export interface Segment {
  segmentId: string
  courseId: string
  chapterId: string
  knowledgePointId: string
  title: string
  startSec: number
  endSec: number
  text: string
  status: ContentStatus
  hasEmbedding: boolean
}

export interface SegmentList {
  segments: Segment[]
  total: number
  offset: number
  limit: number
}

export interface User {
  userId: string
  username: string | null
  displayName: string | null
  role: UserRole
  status: UserStatus
  deviceCount: number
  createdAt: number
  lastActiveAt: number | null
}

export interface UserList {
  users: User[]
  total: number
  offset: number
  limit: number
}

export type MediaAssetStatus =
  | 'awaiting_upload'
  | 'uploaded'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'archived'

export interface MediaAsset {
  assetId: string
  courseId: string
  title: string | null
  status: MediaAssetStatus
  durationMs: number | null
  sourceSizeBytes: number | null
  errorCode: string | null
  createdAt: number
  updatedAt: number
}

export interface MediaAssetList {
  assets: MediaAsset[]
  total: number
  offset: number
  limit: number
}

export type PipelineJobKind = 'ingest' | 'generate'
export type PipelineJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface PipelineJob {
  jobId: string
  assetId: string
  courseId: string
  kind: PipelineJobKind
  status: PipelineJobStatus
  stage: string
  progress: number
  attempts: number
  maxAttempts: number
  cancelRequested: boolean
  errorCode: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface PipelineJobDetail extends PipelineJob {
  result: {
    transcriptId: string | null
    generationId: string | null
  }
}

export interface PipelineJobList {
  jobs: PipelineJob[]
  total: number
  offset: number
  limit: number
}

export interface TranscriptMeta {
  transcriptId: string
  assetId: string
  status: string
  language: string
  durationMs: number | null
  chunkCount: number
  segmentCount: number
  errorCode: string | null
}

export interface TranscriptPage {
  transcript: TranscriptMeta
  segments: { idx: number; startMs: number; endMs: number; text: string }[]
  total: number
  offset: number
  limit: number
}

export type GenerationStatus = 'draft' | 'applied' | 'discarded' | 'failed'

export interface GenerationSummary {
  generationId: string
  assetId: string
  courseId: string
  status: GenerationStatus
  promptVersion: string
  model: string
  chapters: number
  knowledgePoints: number
  segments: number
  needsReview: number
  createdAt: number
  updatedAt: number
  appliedAt: number | null
}

export interface GenerationPreview {
  generation: GenerationSummary
  chapters: { key: string; title: string; position: number }[]
  knowledgePoints: {
    key: string
    chapterKey: string
    title: string
    position: number
    confidence: number
    needsReview: boolean
    reviewReasons: string[]
    hasArticle: boolean
  }[]
  segments: { key: string; pointKey: string; title: string; startMs: number; endMs: number }[]
}

export interface AppliedContent {
  chapters: Record<string, string>
  knowledgePoints: Record<string, string>
  segments: Record<string, string>
}

export interface GenerationApplyResult {
  generation: GenerationSummary
  applied: AppliedContent
  alreadyApplied: boolean
}

export interface CoursePublishResult {
  courseId: string
  status: 'published'
  articlesPublished: number
  segmentsPublished: number
  indexed: boolean
  embedded: number
}

export type LlmPurpose = 'content' | 'embedding'
export type AsrProtocol = 'minimax' | 'openai'
export type ModelTestStatus = 'success' | 'failed'

export interface LlmModelConfig {
  configId: string
  name: string
  provider: string
  protocol: 'openai'
  baseUrl: string
  model: string
  purpose: LlmPurpose
  apiKeyConfigured: boolean
  apiKeyMasked: string | null
  isDefault: boolean
  isActive: boolean
  lastTestedAt: number | null
  lastTestStatus: ModelTestStatus | null
  lastTestError: string | null
  createdAt: number
  updatedAt: number
}

export interface AsrModelConfig {
  provider: string
  protocol: AsrProtocol
  baseUrl: string
  model: string
  apiKeyConfigured: boolean
  apiKeyMasked: string | null
  enabled: boolean
  lastTestedAt: number | null
  lastTestStatus: ModelTestStatus | null
  lastTestError: string | null
  updatedAt: number
}

export interface ModelTestResult {
  status: ModelTestStatus
  detail: string
  testedAt: number
}
