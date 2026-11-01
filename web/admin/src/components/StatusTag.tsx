import { Tag } from 'antd'

const STATUS: Record<string, { color: string; label: string }> = {
  draft: { color: 'default', label: '草稿' },
  published: { color: 'green', label: '已发布' },
  archived: { color: 'gold', label: '已归档' },
  awaiting_upload: { color: 'default', label: '待上传' },
  uploaded: { color: 'blue', label: '已上传' },
  processing: { color: 'processing', label: '处理中' },
  ready: { color: 'green', label: '就绪' },
  failed: { color: 'red', label: '失败' },
  queued: { color: 'default', label: '排队中' },
  running: { color: 'processing', label: '运行中' },
  succeeded: { color: 'green', label: '成功' },
  canceled: { color: 'gold', label: '已取消' },
  applied: { color: 'green', label: '已应用' },
  discarded: { color: 'default', label: '已丢弃' },
  active: { color: 'green', label: '正常' },
  disabled: { color: 'red', label: '已停用' },
  success: { color: 'green', label: '通过' },
  error: { color: 'red', label: '失败' },
  fallback: { color: 'gold', label: '已降级' },
  planned: { color: 'default', label: '待生成' },
  rendering: { color: 'processing', label: '生成中' },
}

export const STAGE_LABELS: Record<string, string> = {
  queued: '排队',
  probe: '探测',
  transcode: '转码',
  transcribe: '转写',
  structure: '结构提取',
  generate: '内容生成',
  figure_plan: '图示规划',
  figure_render: '图示渲染',
  finalize: '收尾',
  done: '完成',
}

export function StatusTag({ value, label }: { value: string; label?: string }) {
  const meta = STATUS[value]
  if (meta === undefined) return <Tag>{label ?? value}</Tag>
  return <Tag color={meta.color}>{label ?? meta.label}</Tag>
}

export function statusLabel(value: string): string {
  return STATUS[value]?.label ?? value
}
