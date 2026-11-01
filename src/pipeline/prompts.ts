import { codePointLength } from '../http/validation.js'
import { MAX_ARTICLE_CHARS, MAX_TITLE_CHARS } from './constants.js'
import type { TranscriptSentence } from './types.js'

export interface ChapterSuggestion {
  title: string
}

export interface KnowledgePointSuggestion {
  title: string
  excerpt: string
  chapterTitle: string
  confidence: number
}

export interface PromptRequest {
  system: string
  user: string
}

const CHAPTER_SYSTEM = [
  '你负责把课程视频的转写整理成分章结构。',
  '只输出 JSON 对象，格式为 {"chapters":[{"title":"章节标题"}]}。',
  '输出 1–6 个按讲解顺序排列的章节，标题为 2–20 字的中文短语，不要编号。',
  '不要输出解释、Markdown 代码块或额外字段。',
].join('\n')

const POINT_SYSTEM = [
  '你负责从课程视频转写中提取可独立讲解的知识点。',
  '只输出 JSON 对象，格式为',
  '{"knowledgePoints":[{"title":"知识点标题","excerpt":"转写原文","chapterTitle":"所属章节标题","confidence":0.8}]}。',
  '最多 8 个知识点；title 为 2–20 字短语；excerpt 必须逐字摘录转写中的一句话，不得改写；',
  'chapterTitle 必须使用给定章节标题之一；confidence 为 0–1 的数字，表示该知识点是否被讲清楚。',
  '没有可提取内容时输出 {"knowledgePoints":[]}。不要输出解释或额外字段。',
].join('\n')

const ARTICLE_SYSTEM = [
  '你负责把一段课程转写整理成可发布的 Markdown 文章。',
  '只输出 JSON 对象，格式为 {"markdown":"# 标题\\n\\n正文"}。',
  '只依据给定转写写作，不补充转写中没有的事实；使用标题、段落、列表组织内容；',
  '禁止 HTML、脚本、iframe 与 javascript: 链接。不要输出解释或额外字段。',
].join('\n')

export function chapterPrompt(window: TranscriptSentence[]): PromptRequest {
  return {
    system: CHAPTER_SYSTEM,
    user: `课程转写：\n${formatTranscript(window)}`,
  }
}

export function pointPrompt(window: TranscriptSentence[], chapterTitles: string[]): PromptRequest {
  return {
    system: POINT_SYSTEM,
    user: [
      `可用章节标题：${chapterTitles.join('、')}`,
      '课程转写：',
      formatTranscript(window),
    ].join('\n'),
  }
}

export function articlePrompt(title: string, window: TranscriptSentence[]): PromptRequest {
  return {
    system: ARTICLE_SYSTEM,
    user: `知识点标题：${title}\n\n相关转写：\n${formatTranscript(window)}`,
  }
}

export function formatTranscript(segments: TranscriptSentence[]): string {
  return segments
    .map(segment => `[${formatTime(segment.startMs)}] ${segment.text}`)
    .join('\n')
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function textValue(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || codePointLength(text) > maxChars) return null
  return text
}

export function parseChapterResponse(value: unknown): ChapterSuggestion[] {
  const root = record(value)
  const list = root?.chapters
  if (!Array.isArray(list) || list.length === 0 || list.length > 6) {
    throw new Error('invalid chapters')
  }
  const chapters: ChapterSuggestion[] = []
  for (const item of list) {
    const entry = record(item)
    const title = textValue(entry?.title, MAX_TITLE_CHARS)
    if (title === null) throw new Error('invalid chapter title')
    chapters.push({ title })
  }
  return chapters
}

export function parsePointResponse(value: unknown): KnowledgePointSuggestion[] {
  const root = record(value)
  const list = root?.knowledgePoints
  if (!Array.isArray(list) || list.length > 8) throw new Error('invalid knowledge points')
  const points: KnowledgePointSuggestion[] = []
  for (const item of list) {
    const entry = record(item)
    const title = textValue(entry?.title, MAX_TITLE_CHARS)
    const excerpt = textValue(entry?.excerpt, 2000)
    const chapterTitle = textValue(entry?.chapterTitle, MAX_TITLE_CHARS) ?? ''
    const confidence = entry?.confidence
    if (title === null || excerpt === null) throw new Error('invalid knowledge point')
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
      throw new Error('invalid knowledge point confidence')
    }
    points.push({
      title,
      excerpt,
      chapterTitle,
      confidence: Math.min(1, Math.max(0, confidence)),
    })
  }
  return points
}

export function parseArticleResponse(value: unknown): string {
  const root = record(value)
  const markdown = textValue(root?.markdown, MAX_ARTICLE_CHARS)
  if (markdown === null) throw new Error('invalid article')
  return markdown
}
