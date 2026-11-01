export const ASSET_STATUSES = [
  'awaiting_upload',
  'uploaded',
  'processing',
  'ready',
  'failed',
  'archived',
] as const
export type AssetStatus = (typeof ASSET_STATUSES)[number]

export const JOB_KINDS = ['ingest', 'generate', 'illustrate'] as const
export type JobKind = (typeof JOB_KINDS)[number]

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const JOB_STAGES = [
  'queued',
  'probe',
  'transcode',
  'transcribe',
  'structure',
  'generate',
  'figure_plan',
  'figure_render',
  'finalize',
  'done',
] as const
export type JobStage = (typeof JOB_STAGES)[number]

export type TranscriptStatus = 'pending' | 'processing' | 'ready' | 'failed'
export type ChunkStatus = 'pending' | 'processing' | 'done' | 'failed'
export type GenerationStatus = 'draft' | 'applied' | 'discarded' | 'failed'

export interface SourceProbe {
  durationMs: number
  videoCodec: string
  audioCodec: string
  width: number | null
  height: number | null
}

export interface TranscriptSentence {
  startMs: number
  endMs: number
  text: string
}

export interface TranscriptSegment extends TranscriptSentence {}

export interface ChunkTranscript {
  startMs: number
  endMs: number
  sentences: TranscriptSentence[]
}

export interface ChapterDraft {
  key: string
  title: string
  position: number
}

export interface KnowledgePointDraft {
  key: string
  chapterKey: string
  title: string
  position: number
  confidence: number
  needsReview: boolean
  reviewReasons: string[]
}

export interface ChapterArticleDraft {
  chapterKey: string
  markdown: string | null
  needsReview: boolean
  reviewReasons: string[]
}

export type FigureKind = 'keyframe' | 'generated'

export interface FigureDraft {
  key: string
  chapterKey: string
  kind: FigureKind
  caption: string
  prompt: string | null
  /** 关键帧的来源时间点（毫秒），文字生图时为 null。 */
  sourceMs: number | null
  needsReview: boolean
  reviewReasons: string[]
}

export interface SegmentDraft {
  key: string
  pointKey: string
  title: string
  startMs: number
  endMs: number
  text: string
}

export interface GenerationPayload {
  chapters: ChapterDraft[]
  knowledgePoints: KnowledgePointDraft[]
  segments: SegmentDraft[]
  chapterArticles: ChapterArticleDraft[]
  figures: FigureDraft[]
}

export interface AppliedContent {
  chapters: Record<string, string>
  knowledgePoints: Record<string, string>
  segments: Record<string, string>
  figures: Record<string, string>
}
