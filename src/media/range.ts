export interface ByteRange {
  start: number
  end: number
}

export type RangeResult = ByteRange | 'invalid' | undefined

/** 只支持单段 Range；多段返回 invalid，由调用方以 416 拒绝。 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return 'invalid'
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return 'invalid'
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid'
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isInteger(start) || !Number.isInteger(end)) return 'invalid'
  if (start > end || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}
