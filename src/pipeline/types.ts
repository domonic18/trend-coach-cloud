export const ASSET_STATUSES = [
  'awaiting_upload',
  'uploaded',
  'processing',
  'ready',
  'failed',
  'archived',
] as const
export type AssetStatus = (typeof ASSET_STATUSES)[number]

export const JOB_KINDS = ['ingest', 'generate'] as const
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
  articleMarkdown: string | null
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
}

export interface AppliedContent {
  chapters: Record<string, string>
  knowledgePoints: Record<string, string>
  segments: Record<string, string>
}
