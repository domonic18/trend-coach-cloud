import dayjs from 'dayjs'

export function formatDate(value: string | number): string {
  const date = dayjs(value)
  return date.isValid() ? date.format('YYYY-MM-DD') : '—'
}

export function formatDateTime(value: number): string {
  const date = dayjs(value)
  return date.isValid() ? date.format('YYYY-MM-DD HH:mm') : '—'
}

export function formatBytes(value: number | null): string {
  if (value === null) return '未提供'
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${value} B`
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}
