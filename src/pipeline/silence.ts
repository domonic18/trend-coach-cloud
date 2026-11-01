export interface SilenceInterval {
  startMs: number
  endMs: number
}

const START = /silence_start:\s*(-?\d+(?:\.\d+)?)/
const END = /silence_end:\s*(-?\d+(?:\.\d+)?)/

function toMs(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) ? Math.max(0, Math.round(value * 1000)) : null
}

/** ffmpeg silencedetect 输出在 stderr；只取起止时间，忽略其余日志。 */
export function parseSilences(stderr: string): SilenceInterval[] {
  const intervals: SilenceInterval[] = []
  let pending: number | null = null
  for (const line of stderr.split('\n')) {
    const start = START.exec(line)
    if (start !== null) {
      pending = toMs(start[1])
      continue
    }
    const end = END.exec(line)
    if (end === null) continue
    const endMs = toMs(end[1])
    if (pending !== null && endMs !== null && endMs > pending) {
      intervals.push({ startMs: pending, endMs })
    }
    pending = null
  }
  return mergeSilences(intervals)
}

export function mergeSilences(intervals: SilenceInterval[]): SilenceInterval[] {
  const sorted = intervals
    .filter(interval => interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs)
  const merged: SilenceInterval[] = []
  for (const interval of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs)
    } else {
      merged.push({ startMs: interval.startMs, endMs: interval.endMs })
    }
  }
  return merged
}
