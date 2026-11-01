import { codePointLength } from '../http/validation.js'
import { MAX_TITLE_CHARS } from './constants.js'
import type { TranscriptSentence } from './types.js'

const NON_TEXT = /[\s\p{P}\p{S}]+/gu
const ASCII_WORD_END = /[A-Za-z0-9.,!?;:'")\]]$/
const ASCII_WORD_START = /^[A-Za-z0-9(["']/

/** 锚定比较时忽略空白、标点与全半角差异，但不改变文字顺序。 */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(NON_TEXT, '')
}

export function joinText(left: string, right: string): string {
  if (left === '') return right
  if (right === '') return left
  return ASCII_WORD_END.test(left) && ASCII_WORD_START.test(right) ? `${left} ${right}` : `${left}${right}`
}

export function truncateText(text: string, maxChars: number): string {
  const chars = Array.from(text)
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('')
}

function hardSplit(text: string, limit: number): string[] {
  const chars = Array.from(text)
  if (chars.length <= limit) return [text]
  const parts: string[] = []
  for (let index = 0; index < chars.length; index += limit) {
    parts.push(chars.slice(index, index + limit).join(''))
  }
  return parts
}

/** 优先在句末断开；无标点的长文本按码点硬切，保证单段不超限。 */
export function splitTextByChars(text: string, maxChars: number): string[] {
  const limit = Math.max(1, maxChars)
  const pieces = text
    .split(/(?<=[。！？；!?;.\n])/u)
    .map(piece => piece.trim())
    .filter(piece => piece.length > 0)
  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    for (const part of hardSplit(piece, limit)) {
      if (current === '') {
        current = part
      } else if (codePointLength(current) + codePointLength(part) <= limit) {
        current = joinText(current, part)
      } else {
        chunks.push(current)
        current = part
      }
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/** excerpt 必须在原句中逐字出现；命中则返回覆盖范围，失败返回 null。 */
export function locateExcerpt(
  sentences: TranscriptSentence[],
  excerpt: string,
): { startMs: number; endMs: number } | null {
  const target = normalizeForMatch(excerpt)
  if (target === '') return null

  let haystack = ''
  const owners: number[] = []
  for (const [index, sentence] of sentences.entries()) {
    const normalized = normalizeForMatch(sentence.text)
    haystack += normalized
    for (let offset = 0; offset < normalized.length; offset += 1) owners.push(index)
  }

  const at = haystack.indexOf(target)
  if (at < 0) return null
  const startIndex = owners[at]
  const endIndex = owners[at + target.length - 1]
  if (startIndex === undefined || endIndex === undefined) return null
  const start = sentences[startIndex]
  const end = sentences[endIndex]
  if (start === undefined || end === undefined) return null
  return { startMs: start.startMs, endMs: end.endMs }
}

export function uniqueTitle(raw: string, used: Set<string>): string {
  const base = truncateText(raw.trim(), MAX_TITLE_CHARS) || '未命名'
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let index = 2; ; index += 1) {
    const suffix = `（${index}）`
    const candidate = `${truncateText(base, MAX_TITLE_CHARS - codePointLength(suffix))}${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}
