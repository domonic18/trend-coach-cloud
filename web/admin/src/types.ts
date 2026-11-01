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
  chapterArticleCount: number
  figureCount: number
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
}

export interface QuizQuestion {
  questionId: string
  prompt: string
  options: string[]
  answerIndex: number
  explanation: string
}

export interface Quiz extends ArticleMeta {
  questions: QuizQuestion[]
}

export interface Chapter {
  chapterId: string
  title: string
  position: number
  article: ArticleMeta | null
  quiz: ArticleMeta | null
  figureCount: number
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

export type PipelineJobKind = 'ingest' | 'generate' | 'illustrate'
export type PipelineJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface PipelineJob {
  jobId: string
  assetId: string | null
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

export interface GenerationCounts {
  chapters: number
  knowledgePoints: number
  chapterArticles: number
  figures: number
  segments: number
  needsReview: number
}

export interface GenerationSummary {
  generationId: string
  assetId: string
  courseId: string
  status: GenerationStatus
  promptVersion: string
  model: string
  counts: GenerationCounts
  createdAt: number
  appliedAt: number | null
}

export interface GenerationPreview {
  generation: GenerationSummary
  chapters: {
    key: string
    title: string
    position: number
    articleLength: number
    hasArticle: boolean
    figureCount: number
  }[]
  knowledgePoints: {
    key: string
    chapterKey: string
    title: string
    position: number
    confidence: number
    needsReview: boolean
    reviewReasons: string[]
  }[]
  figures: {
    key: string
    chapterKey: string
    kind: string
    caption: string
    candidateCount: number
    needsReview: boolean
  }[]
  segments: { key: string; pointKey: string; title: string; startMs: number; endMs: number }[]
}

export interface GenerationApplyResult {
  generationId: string
  alreadyApplied: boolean
  courseId: string
  chapters: { chapterId: string; key: string }[]
  knowledgePoints: { knowledgePointId: string; key: string }[]
  figures: { figureId: string; key: string }[]
  segments: { segmentId: string; key: string }[]
  chapterArticles: number
  figuresApplied: number
}

export interface CoursePublishResult {
  courseId: string
  published: true
  indexed: boolean
  embedded: number
  counts: {
    chapters: number
    knowledgePoints: number
    chapterArticles: number
    figures: number
    segments: number
  }
}

export type FigureStatus = 'planned' | 'rendering' | 'ready' | 'failed' | 'published'
export type FigureCandidateStatus = 'rendering' | 'ready' | 'failed'

export interface FigureCandidate {
  candidateId: string
  status: FigureCandidateStatus
  width: number | null
  height: number | null
  bytes: number | null
  sourceSec: number | null
  errorCode: string | null
  previewUrl: string | null
}

export interface Figure {
  figureId: string
  chapterId: string
  kind: 'keyframe' | 'generated'
  caption: string
  status: FigureStatus
  selectedCandidateId: string | null
  prompt: string | null
  model: string | null
  seed: number | null
  reviewReasons: string[]
  candidates: FigureCandidate[]
}

export interface FigureList {
  figures: Figure[]
  total: number
  offset: number
  limit: number
}

export type LlmPurpose = 'content' | 'embedding' | 'image'
export type LlmProtocol = 'openai' | 'anthropic'
export type AsrProtocol = 'minimax' | 'openai'
export type ModelTestStatus = 'success' | 'failed'

export interface LlmModelConfig {
  configId: string
  name: string
  provider: string
  protocol: LlmProtocol
  baseUrl: string
  model: string
  purpose: LlmPurpose
  apiKeyConfigured: boolean
  apiKeyMasked: string | null
  isDefault: boolean
  isActive: boolean
  inputPriceMicrosPer1k: number | null
  outputPriceMicrosPer1k: number | null
  imagePriceMicros: number
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

export type AiTaskKey =
  | 'content.outline'
  | 'content.points'
  | 'content.article'
  | 'content.chapter_article'
  | 'content.figure_plan'
  | 'image.figure'
  | 'embedding.query'
  | 'embedding.segment'
  | 'asr.longform'
export type AiUsageStatus = 'success' | 'error' | 'fallback'
export type AiRunStatus = 'running' | 'succeeded' | 'failed'
export type AiRunSource = 'pipeline' | 'admin'

export interface AiUsageTotals {
  requests: number
  errors: number
  fallbacks: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  audioSeconds: number
  characters: number
  avgLatencyMs: number
  costMicros: number | null
}

export interface AiUsageDailyPoint {
  date: string
  requests: number
  inputTokens: number
  outputTokens: number
  costMicros: number | null
}

export interface AiUsageByTask {
  taskKey: AiTaskKey
  label: string
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
  audioSeconds: number
  characters: number
  costMicros: number | null
}

export interface AiUsageByModel {
  configId: string | null
  provider: string | null
  model: string | null
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
  costMicros: number | null
}

export interface AiUsageSummary {
  from: string
  to: string
  totals: AiUsageTotals
  daily: AiUsageDailyPoint[]
  byTask: AiUsageByTask[]
  byModel: AiUsageByModel[]
}

export interface AiUsageEvent {
  usageId: string
  runId: string | null
  taskKey: AiTaskKey
  label: string
  provider: string | null
  model: string | null
  configId: string | null
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  audioSeconds: number
  characters: number
  latencyMs: number
  status: AiUsageStatus
  errorCode: string | null
  createdAt: string
}

export interface AiUsageEventPage {
  events: AiUsageEvent[]
  nextCursor: string | null
}

export interface AiRun {
  runId: string
  taskKey: AiTaskKey
  label: string
  source: AiRunSource
  sourceId: string | null
  status: AiRunStatus
  primaryConfigId: string | null
  fallbackUsed: boolean
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  errorCode: string | null
}

export interface AiRunPage {
  runs: AiRun[]
  nextCursor: string | null
}

export interface AiRunStep {
  stepId: string
  seq: number
  taskKey: AiTaskKey
  configId: string | null
  provider: string | null
  model: string | null
  attempt: number
  status: AiUsageStatus
  latencyMs: number
  usageId: string | null
  errorCode: string | null
  createdAt: string
}

export interface AiRunDetail extends AiRun {
  summary: unknown
  steps: AiRunStep[]
}

export interface AiTaskBinding {
  taskKey: AiTaskKey
  label: string
  purpose: LlmPurpose
  primaryConfigId: string | null
  fallbackConfigId: string | null
  updatedAt: string | null
}

export interface AiBindingsResponse {
  bindings: AiTaskBinding[]
  configs: LlmModelConfig[]
}

export interface AiConfigHealth {
  configId: string
  name: string
  provider: string
  model: string
  purpose: LlmPurpose
  isActive: boolean
  consecutiveFailures: number
  cooldownUntil: string | null
  coolingDown: boolean
  lastError: string | null
  lastFailureAt: string | null
  lastSuccessAt: string | null
}

export interface AiHealthResponse {
  configs: AiConfigHealth[]
}
