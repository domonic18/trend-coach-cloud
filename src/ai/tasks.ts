import type { LlmPurpose } from '../model-config/service.js'

/** 云端 AI 任务白名单；新增任务必须同步 OpenAPI 与后台筛选。 */
export const AI_TASKS = [
  'content.outline',
  'content.points',
  'content.article',
  'embedding.query',
  'embedding.segment',
  'asr.longform',
] as const

export type AiTaskKey = (typeof AI_TASKS)[number]

/** ASR 不参与 LLM 任务绑定，只记录用量。 */
export const LLM_TASKS = AI_TASKS.filter(task => task !== 'asr.longform')
export type LlmTaskKey = Exclude<AiTaskKey, 'asr.longform'>

export function isAiTaskKey(value: string): value is AiTaskKey {
  return (AI_TASKS as readonly string[]).includes(value)
}

export function isLlmTaskKey(value: string): value is LlmTaskKey {
  return value !== 'asr.longform' && isAiTaskKey(value)
}

export function taskPurpose(taskKey: LlmTaskKey): LlmPurpose {
  return taskKey.startsWith('embedding.') ? 'embedding' : 'content'
}

export const TASK_LABELS: Record<AiTaskKey, string> = {
  'content.outline': '内容大纲',
  'content.points': '知识点提取',
  'content.article': '知识点文章',
  'embedding.query': '检索向量',
  'embedding.segment': '片段向量',
  'asr.longform': '语音转写',
}
