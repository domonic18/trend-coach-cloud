import { ASR_CHUNK_MIN_SEC, WINDOW_OVERLAP_MS } from './constants.js'
import { mergeSilences, type SilenceInterval } from './silence.js'
import type { TranscriptSentence } from './types.js'

export interface AudioChunk {
  index: number
  startMs: number
  endMs: number
}

/** 在静音区中点切块，避免把一句话切成两半；找不到静音时按上限硬切。 */
export function planAudioChunks(input: {
  durationMs: number
  maxSec: number
  silences: SilenceInterval[]
  minSec?: number
}): AudioChunk[] {
  const duration = Math.max(0, Math.round(input.durationMs))
  const maxMs = Math.max(1000, Math.round(input.maxSec * 1000))
  const minMs = Math.min(maxMs, Math.max(1000, Math.round((input.minSec ?? ASR_CHUNK_MIN_SEC) * 1000)))
  const silences = mergeSilences(input.silences)

  const chunks: AudioChunk[] = []
  let cursor = 0
  while (cursor < duration) {
    const target = Math.min(cursor + maxMs, duration)
    const end = target < duration ? bestCut(cursor, target, minMs, silences) ?? target : target
    if (end <= cursor) break
    chunks.push({ index: chunks.length, startMs: cursor, endMs: end })
    cursor = end
  }
  return chunks
}

function bestCut(
  startMs: number,
  targetMs: number,
  minMs: number,
  silences: SilenceInterval[],
): number | null {
  const floor = startMs + minMs
  let best: number | null = null
  for (const interval of silences) {
    if (interval.endMs <= floor || interval.startMs >= targetMs) continue
    const midpoint = Math.round((interval.startMs + interval.endMs) / 2)
    const candidate = Math.min(Math.max(midpoint, floor), targetMs)
    if (candidate >= floor && candidate <= targetMs) best = candidate
  }
  return best
}

export interface TranscriptWindow {
  index: number
  startMs: number
  endMs: number
  sentences: TranscriptSentence[]
}

/** 600s 窗口按转写片段边界回退，窗口之间保留一段重叠。 */
export function planWindows(
  sentences: TranscriptSentence[],
  options: { windowMs: number; overlapMs?: number },
): TranscriptWindow[] {
  const windowMs = Math.max(1000, Math.round(options.windowMs))
  const overlapMs = Math.max(0, Math.round(options.overlapMs ?? WINDOW_OVERLAP_MS))
  const windows: TranscriptWindow[] = []
  if (sentences.length === 0) return windows

  const last = sentences[sentences.length - 1]
  const duration = last?.endMs ?? 0
  let startMs = 0
  while (startMs < duration) {
    const endMs = Math.min(startMs + windowMs, duration)
    windows.push({
      index: windows.length,
      startMs,
      endMs,
      sentences: sentences.filter(sentence => sentence.endMs > startMs && sentence.startMs < endMs),
    })
    if (endMs >= duration) break
    const aligned = alignToSentence(sentences, endMs - overlapMs)
    const next = aligned > startMs ? aligned : endMs
    if (next <= startMs) break
    startMs = next
  }
  return windows
}

function alignToSentence(sentences: TranscriptSentence[], target: number): number {
  for (const sentence of sentences) {
    if (sentence.endMs > target) return sentence.startMs
  }
  return target
}
