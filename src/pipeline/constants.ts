import { MAX_ARTICLE, MAX_TEXT, MAX_TITLE } from '../content/service.js'

export const PROMPT_VERSION = 'm8-v1'

/** MiniMax 单次转写上限约 500s，留出余量。 */
export const ASR_CHUNK_MAX_SEC = 480
export const ASR_CHUNK_MIN_SEC = 20

/** 生成窗口之间至少重叠一个转写片段，便于跨窗口合并知识点。 */
export const WINDOW_OVERLAP_MS = 30_000

export const MAX_TITLE_CHARS = MAX_TITLE
export const MAX_TEXT_CHARS = MAX_TEXT
export const MAX_ARTICLE_CHARS = MAX_ARTICLE

/** 章节教材建议 1500–3000 字，低于下限标待审，硬上限仍由 MAX_ARTICLE_CHARS 把关。 */
export const CHAPTER_ARTICLE_MIN_CHARS = 1500
export const CHAPTER_ARTICLE_TARGET_CHARS = 3000

export const MAX_FIGURES_PER_CHAPTER = 3
export const FIGURE_CANDIDATES_PER_DRAFT = 2
export const FIGURE_RENDER_RETRIES = 1

/** 单课图片预算 ¥10，组织月度 ¥300；达到 80% 预警，100% 硬停（单位 micros）。 */
export const COURSE_IMAGE_BUDGET_MICROS = 10_000_000
export const ORG_MONTHLY_IMAGE_BUDGET_MICROS = 300_000_000
export const IMAGE_BUDGET_WARN_RATIO = 0.8

/** 文章生成时向知识点时间窗前后各取一段转写作为上下文，避免只有一句话可写。 */
export const ARTICLE_CONTEXT_MS = 60_000

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
  chapterArticleInvalid: 'chapter_article_invalid',
  figurePlanInvalid: 'figure_plan_invalid',
  imageUnavailable: 'image_unavailable',
  imageBudgetExceeded: 'image_budget_exceeded',
  illustrationFailed: 'illustration_failed',
  embeddingUnavailable: 'embedding_unavailable',
  canceled: 'job_canceled',
  internal: 'internal',
} as const

export const REVIEW_REASONS = {
  excerptNotFound: 'excerpt_not_found',
  lowConfidence: 'low_confidence',
  articleInvalid: 'article_invalid',
  articleShort: 'article_short',
  chapterArticleInvalid: 'chapter_article_invalid',
  chapterArticleShort: 'chapter_article_short',
  figurePlanInvalid: 'figure_plan_invalid',
  figureRenderFailed: 'figure_render_failed',
  figureUnresolved: 'figure_unresolved',
} as const
