import type {
  AiRunSource,
  AiRunStatus,
  AiTaskKey,
  ContentStatus,
  UserRole,
  UserStatus,
} from '../types'

export interface SegmentFilters {
  courseId: string
  knowledgePointId: string
  status: '' | ContentStatus
  query: string
  offset: number
  limit: number
}

export interface JobFilters {
  courseId?: string
  kind?: 'ingest' | 'generate' | 'illustrate'
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  limit?: number
}

export interface UserFilters {
  query: string
  role: '' | UserRole
  status: '' | UserStatus
  offset: number
  limit: number
}

export interface AiUsageFilters {
  from: string
  to: string
  task: '' | AiTaskKey
}

export interface AiEventFilters extends AiUsageFilters {
  model: string
  limit: number
}

export interface AiRunFilters {
  from: string
  to: string
  task: '' | AiTaskKey
  status: '' | AiRunStatus
  source: '' | AiRunSource
  limit: number
}

export const qk = {
  session: ['auth', 'session'] as const,
  courses: ['content', 'courses'] as const,
  course: (courseId: string) => ['content', 'course', courseId] as const,
  chapterArticle: (courseId: string, chapterId: string) =>
    ['content', 'chapter-article', courseId, chapterId] as const,
  figures: (courseId: string, chapterId: string) =>
    ['content', 'figures', courseId, chapterId] as const,
  segments: (filters: SegmentFilters) => ['segments', filters] as const,
  assets: (courseId: string | null, status?: string) => ['pipeline', 'assets', courseId, status ?? ''] as const,
  jobs: (filters: JobFilters) => ['pipeline', 'jobs', filters] as const,
  transcript: (assetId: string, offset: number, limit: number) =>
    ['pipeline', 'transcript', assetId, offset, limit] as const,
  generation: (generationId: string) => ['pipeline', 'generation', generationId] as const,
  users: (filters: UserFilters) => ['accounts', 'users', filters] as const,
  llmConfigs: ['models', 'llm'] as const,
  asrConfig: ['models', 'asr'] as const,
  aiUsageSummary: (filters: AiUsageFilters) => ['ai', 'usage', 'summary', filters] as const,
  aiUsageEvents: (filters: AiEventFilters) => ['ai', 'usage', 'events', filters] as const,
  aiRuns: (filters: AiRunFilters) => ['ai', 'runs', filters] as const,
  aiRun: (runId: string) => ['ai', 'runs', 'detail', runId] as const,
  aiBindings: ['ai', 'bindings'] as const,
  aiHealth: ['ai', 'health'] as const,
}
