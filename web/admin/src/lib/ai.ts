import type { AiRunSource, AiTaskKey } from '../types'

export const AI_TASK_LABELS: Record<AiTaskKey, string> = {
  'content.outline': '内容大纲',
  'content.points': '知识点提取',
  'content.article': '知识点文章',
  'embedding.query': '检索向量',
  'embedding.segment': '片段向量',
  'asr.longform': '语音转写',
}

export const AI_TASK_OPTIONS = (Object.keys(AI_TASK_LABELS) as AiTaskKey[]).map(taskKey => ({
  value: taskKey,
  label: AI_TASK_LABELS[taskKey],
}))

export const RUN_SOURCE_LABELS: Record<AiRunSource, string> = {
  pipeline: '建课管线',
  admin: '后台手动',
}

export const RUN_STATUS_OPTIONS = [
  { value: 'running', label: '运行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
]

export const RUN_SOURCE_OPTIONS = [
  { value: 'pipeline', label: '建课管线' },
  { value: 'admin', label: '后台手动' },
]
