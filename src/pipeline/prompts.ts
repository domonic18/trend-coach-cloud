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

const OUTLINE_SYSTEM = [
  '你负责为整门课程视频划出章节大纲。',
  '只输出 JSON 对象，格式为 {"chapters":[{"title":"章节标题"}]}。',
  '按讲解顺序输出 3–8 个章节：总时长 30 分钟以内 3–6 个，超过 30 分钟 5–8 个。',
  '每个章节应是一个独立、体量相当的讲解单元，不要把同一主题拆成多章，也不要遗漏结尾内容。',
  '标题为 2–20 字的中文短语，不要编号。不要输出解释、Markdown 代码块或额外字段。',
].join('\n')

const POINT_SYSTEM = [
  '你负责从课程视频转写中提取可独立讲解的知识点。',
  '只输出 JSON 对象，格式为',
  '{"knowledgePoints":[{"title":"知识点标题","excerpt":"转写原文","chapterTitle":"所属章节标题","confidence":0.8}]}。',
  '最多 8 个知识点；title 为 2–20 字短语；excerpt 必须逐字摘录转写中的一句话，不得改写；',
  'chapterTitle 必须使用给定章节标题之一；confidence 为 0–1 的数字，表示该知识点是否被讲清楚。',
  '没有可提取内容时输出 {"knowledgePoints":[]}。不要输出解释或额外字段。',
].join('\n')

const CHAPTER_ARTICLE_SYSTEM = [
  '你负责把一个章节的课程转写整理成可发布的 Markdown 教材。',
  '只输出 JSON 对象，格式为 {"markdown":"# 标题\\n\\n正文"}。',
  '只依据给定转写写作，不补充转写中没有的事实；用二级/三级标题、段落、列表组织多个知识点；',
  '正文 1500–3000 字：先讲清概念与判断依据，再结合转写中的例子逐步展开，最后给出可执行的检查清单；',
  '禁止 HTML、脚本、iframe、javascript: 链接与任何图片外链；不要输出解释或额外字段。',
].join('\n')

const FIGURE_PLAN_SYSTEM = [
  '你负责为一个章节设计 0–3 张教学图示。',
  '只输出 JSON 对象，格式为 {"figures":[{"kind":"keyframe","caption":"图示说明","sourceHint":"转写原文"},',
  '{"kind":"generated","caption":"图示说明","prompt":"图像生成提示词"}]}。',
  'keyframe 用于原视频中已有的图表画面：sourceHint 必须逐字摘录转写中的一句话，便于定位画面时间；',
  'generated 用于补画示意图：prompt 用中文描述一张纯净的教学示意图（如趋势结构、均线排列、流程步骤），',
  '禁止出现真实 K 线截图、具体收益数字、品牌与人物；不要生成包含文字标签的复杂图表；',
  'caption 为 6–40 字的说明，不得重复；宁缺毋滥，没有合适的图就输出 {"figures":[]}。不要输出额外字段。',
].join('\n')

export function outlinePrompt(digest: TranscriptSentence[], durationMs: number): PromptRequest {
  const minutes = Math.max(1, Math.round(durationMs / 60_000))
  return {
    system: OUTLINE_SYSTEM,
    user: `课程总时长：${minutes} 分钟\n课程转写节选：\n${formatTranscript(digest)}`,
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

export function chapterArticlePrompt(
  title: string,
  points: { title: string }[],
  segments: TranscriptSentence[],
  figures: { key: string; caption: string }[],
): PromptRequest {
  const figureLines = figures.length === 0
    ? []
    : [
        '可用图示（在正文合适位置单独一行插入 ![说明](figure:键)，每个键最多出现一次；没有必要时可以不用）：',
        ...figures.map(figure => `${figure.key} ${figure.caption}`),
        '',
      ]
  return {
    system: CHAPTER_ARTICLE_SYSTEM,
    user: [
      `章节标题：${title}`,
      `本章知识点：${points.map(point => point.title).join('、')}`,
      ...figureLines,
      '本章转写：',
      formatTranscript(segments),
    ].join('\n'),
  }
}

export function figurePlanPrompt(title: string, segments: TranscriptSentence[]): PromptRequest {
  return {
    system: FIGURE_PLAN_SYSTEM,
    user: `章节标题：${title}\n\n本章转写：\n${formatTranscript(segments)}`,
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
  if (!Array.isArray(list) || list.length === 0 || list.length > 10) {
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

export function parseChapterArticleResponse(value: unknown): string {
  const root = record(value)
  const markdown = textValue(root?.markdown, MAX_ARTICLE_CHARS)
  if (markdown === null) throw new Error('invalid chapter article')
  return markdown
}

export interface FigurePlanSuggestion {
  kind: 'keyframe' | 'generated'
  caption: string
  prompt: string | null
  sourceHint: string | null
}

export function parseFigurePlanResponse(value: unknown): FigurePlanSuggestion[] {
  const root = record(value)
  const list = root?.figures
  if (!Array.isArray(list) || list.length > 3) throw new Error('invalid figure plan')
  const figures: FigurePlanSuggestion[] = []
  for (const item of list) {
    const entry = record(item)
    const kind = entry?.kind
    const caption = textValue(entry?.caption, MAX_TITLE_CHARS)
    if (caption === null) throw new Error('invalid figure caption')
    if (kind === 'keyframe') {
      const sourceHint = textValue(entry?.sourceHint, 2000)
      if (sourceHint === null) throw new Error('invalid figure source hint')
      figures.push({ kind, caption, prompt: null, sourceHint })
    } else if (kind === 'generated') {
      const prompt = textValue(entry?.prompt, 2000)
      if (prompt === null) throw new Error('invalid figure prompt')
      figures.push({ kind, caption, prompt, sourceHint: null })
    } else {
      throw new Error('invalid figure kind')
    }
  }
  return figures
}
