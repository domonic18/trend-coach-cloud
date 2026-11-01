import { MAX_ARTICLE, MAX_TEXT, MAX_TITLE } from '../content/service.js'

export const PROMPT_VERSION = 'm1-v1'

/** MiniMax 单次转写上限约 500s，留出余量。 */
export const ASR_CHUNK_MAX_SEC = 480
export const ASR_CHUNK_MIN_SEC = 20

/** 生成窗口之间至少重叠一个转写片段，便于跨窗口合并知识点。 */
export const WINDOW_OVERLAP_MS = 30_000

export const MAX_TITLE_CHARS = MAX_TITLE
export const MAX_TEXT_CHARS = MAX_TEXT
export const MAX_ARTICLE_CHARS = MAX_ARTICLE

export const PIPELINE_ERRORS = {
  sourceMissing: 'source_missing',
  sourceInvalid: 'source_invalid',
  ffmpegFailed: 'ffmpeg_failed',
  transcribeFailed: 'transcribe_failed',
  asrUnavailable: 'asr_unavailable',
  llmUnavailable: 'llm_unavailable',
  generationFailed: 'generation_failed',
  budgetExceeded: 'generation_budget_exceeded',
  articleInvalid: 'article_invalid',
  embeddingUnavailable: 'embedding_unavailable',
  canceled: 'job_canceled',
  internal: 'internal',
} as const

export const REVIEW_REASONS = {
  excerptNotFound: 'excerpt_not_found',
  lowConfidence: 'low_confidence',
  articleInvalid: 'article_invalid',
} as const
