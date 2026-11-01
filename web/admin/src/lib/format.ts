import dayjs from 'dayjs'

export function formatDateTime(value: number | null): string {
  if (value === null) return '—'
  return dayjs(value).format('YYYY-MM-DD HH:mm')
}

export function formatClock(ms: number | null): string {
  if (ms === null) return '—'
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function formatSeconds(sec: number): string {
  return formatClock(sec * 1000)
}

export function formatBytes(value: number | null): string {
  if (value === null) return '—'
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`
  return `${(value / 1024).toFixed(1)} KiB`
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败'
}

export function formatCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

/** 成本单位为微美元，后端未配置价格时返回 null，不猜测单价。 */
export function formatCost(micros: number | null): string {
  if (micros === null) return '未配置价格'
  return `$${(micros / 1_000_000).toFixed(4)}`
}

export function formatPricePer1k(micros: number | null): string {
  if (micros === null) return '—'
  return `$${(micros / 1_000_000).toFixed(6)}/1k`
}

export function formatPricePerImage(micros: number | null): string {
  if (micros === null) return '—'
  return `$${(micros / 1_000_000).toFixed(4)}/张`
}

export function formatIso(value: string | null): string {
  if (value === null) return '—'
  return dayjs(value).format('YYYY-MM-DD HH:mm:ss')
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
