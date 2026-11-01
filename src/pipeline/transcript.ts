import { codePointLength } from '../http/validation.js'
import { MAX_TEXT_CHARS } from './constants.js'
import { joinText, splitTextByChars } from './text.js'
import type { ChunkTranscript, TranscriptSegment, TranscriptSentence } from './types.js'

const TEXT_KEYS = ['text', 'sentence', 'content'] as const
const MS_START_KEYS = ['startMs', 'start_ms'] as const
const MS_END_KEYS = ['endMs', 'end_ms'] as const
const SEC_START_KEYS = ['start', 'start_time'] as const
const SEC_END_KEYS = ['end', 'end_time'] as const
const LISTS = ['sentences', 'segments', 'utterances'] as const

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function numberKey(item: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }
  return null
}

function textOf(item: Record<string, unknown>): string | null {
  for (const key of TEXT_KEYS) {
    const value = item[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 兼容 OpenAI Whisper 风格（秒）与 *_ms（毫秒）；MiniMax verbose 字段名不稳定，
 * 无时间戳时退化为整段一句话，由上层把时间范围设为本块范围。
 */
export function parseTimedSentences(payload: unknown, durationMs: number): TranscriptSentence[] {
  const root = record(payload)
  if (root === null) return []
  const duration = Math.max(1, Math.round(durationMs))

  for (const key of LISTS) {
    const list = root[key]
    if (!Array.isArray(list)) continue
    const parsed: TranscriptSentence[] = []
    for (const entry of list) {
      const item = record(entry)
      if (item === null) continue
      const text = textOf(item)
      if (text === null) continue
      const startSec = numberKey(item, SEC_START_KEYS)
      const endSec = numberKey(item, SEC_END_KEYS)
      const start = numberKey(item, MS_START_KEYS) ?? (startSec === null ? null : startSec * 1000)
      const end = numberKey(item, MS_END_KEYS) ?? (endSec === null ? null : endSec * 1000)
      if (start === null || end === null) continue
      const startMs = clamp(Math.round(start), 0, duration - 1)
      const endMs = clamp(Math.round(end), startMs + 1, duration)
      if (endMs <= startMs) continue
      parsed.push({ startMs, endMs, text })
    }
    if (parsed.length > 0) {
      return parsed.sort((left, right) => left.startMs - right.startMs)
    }
  }

  const fallback = typeof root.text === 'string' ? root.text.trim() : ''
  return fallback === '' ? [] : [{ startMs: 0, endMs: duration, text: fallback }]
}

/** 块内时间戳是相对偏移；合并后必须单调递增且限制在块范围内。 */
export function mergeChunkSentences(chunks: ChunkTranscript[]): TranscriptSentence[] {
  const merged: TranscriptSentence[] = []
  let previousEnd = 0
  for (const chunk of [...chunks].sort((left, right) => left.startMs - right.startMs)) {
    for (const sentence of chunk.sentences) {
      const start = clamp(chunk.startMs + sentence.startMs, previousEnd, chunk.endMs - 1)
      const end = clamp(chunk.startMs + sentence.endMs, start + 1, chunk.endMs)
      const text = sentence.text.trim()
      if (text === '' || end <= start) continue
      merged.push({ startMs: start, endMs: end, text })
      previousEnd = end
    }
  }
  return merged
}

export function groupTranscriptSegments(
  sentences: TranscriptSentence[],
  maxSec: number,
): TranscriptSegment[] {
  const maxMs = Math.max(1000, Math.round(maxSec * 1000))
  const segments: TranscriptSegment[] = []
  let current: TranscriptSegment | null = null

  for (const sentence of sentences) {
    if (sentence.endMs - sentence.startMs > maxMs || codePointLength(sentence.text) > MAX_TEXT_CHARS) {
      if (current !== null) {
        segments.push(current)
        current = null
      }
      segments.push(...splitLongSentence(sentence, maxMs))
      continue
    }
    if (current === null) {
      current = { ...sentence }
      continue
    }
    const text = joinText(current.text, sentence.text)
    if (sentence.endMs - current.startMs <= maxMs && codePointLength(text) <= MAX_TEXT_CHARS) {
      current.endMs = sentence.endMs
      current.text = text
    } else {
      segments.push(current)
      current = { ...sentence }
    }
  }
  if (current !== null) segments.push(current)
  return segments.filter(segment => segment.text !== '' && segment.endMs > segment.startMs)
}

function splitLongSentence(sentence: TranscriptSentence, maxMs: number): TranscriptSegment[] {
  const duration = sentence.endMs - sentence.startMs
  const parts = Math.max(1, Math.ceil(duration / maxMs))
  const limit = Math.max(1, Math.floor(MAX_TEXT_CHARS / parts))
  const texts = splitTextByChars(sentence.text, Math.min(MAX_TEXT_CHARS, limit))
  const total = texts.reduce((sum, text) => sum + codePointLength(text), 0) || 1

  const result: TranscriptSegment[] = []
  let cursor = sentence.startMs
  for (const [index, text] of texts.entries()) {
    const isLast = index === texts.length - 1
    const share = Math.round((duration * codePointLength(text)) / total)
    const end = isLast
      ? sentence.endMs
      : Math.min(sentence.endMs, Math.max(cursor + 1, cursor + share))
    result.push({ startMs: cursor, endMs: Math.max(cursor + 1, end), text })
    cursor = end
  }
  return result
}
