import type { LlmPurpose } from '../model-config/service.js'

/** 云端 AI 任务白名单；新增任务必须同步 OpenAPI 与后台筛选。 */
export const AI_TASKS = [
  'content.outline',
  'content.points',
  'content.article',
  'content.chapter_article',
  'content.figure_plan',
  'image.figure',
  'embedding.query',
  'embedding.segment',
  'asr.longform',
] as const

export type AiTaskKey = (typeof AI_TASKS)[number]

/** ASR 与文生图不参与 LLM 任务绑定，只记录用量。 */
export const LLM_TASKS = AI_TASKS.filter(task => task !== 'asr.longform' && task !== 'image.figure')
export type LlmTaskKey = Exclude<AiTaskKey, 'asr.longform' | 'image.figure'>

export function isAiTaskKey(value: string): value is AiTaskKey {
  return (AI_TASKS as readonly string[]).includes(value)
}

export function isLlmTaskKey(value: string): value is LlmTaskKey {
  return value !== 'asr.longform' && value !== 'image.figure' && isAiTaskKey(value)
}

export function taskPurpose(taskKey: LlmTaskKey): LlmPurpose {
  if (taskKey.startsWith('embedding.')) return 'embedding'
  return 'content'
}

export const TASK_LABELS: Record<AiTaskKey, string> = {
  'content.outline': '内容大纲',
  'content.points': '知识点提取',
  'content.article': '知识点文章（旧）',
  'content.chapter_article': '章节教材',
  'content.figure_plan': '图示规划',
  'image.figure': '图示生成',
  'embedding.query': '检索向量',
  'embedding.segment': '片段向量',
  'asr.longform': '语音转写',
}
