import type { ChunkTranscript, TranscriptSentence } from '../src/pipeline/types.js'

export const SILENCEDETECT_STDERR = [
  '[silencedetect @ 0x55] silence_start: 5',
  '[silencedetect @ 0x55] silence_end: 8.2 | silence_duration: 3.2',
  '[silencedetect @ 0x55] silence_start: 7.9',
  '[silencedetect @ 0x55] silence_end: 9',
  '[silencedetect @ 0x55] silence_start: 20',
  '[silencedetect @ 0x55] silence_end: 21',
].join('\n')

export const VERBOSE_TRANSCRIPT = {
  text: '整段文本',
  segments: [
    { start: 0.5, end: 1.5, text: '第一段' },
    { start: 1.5, end: 2.4, text: '第二段' },
  ],
}

export function sentenceFixtures(count = 20, stepMs = 10_000): TranscriptSentence[] {
  return Array.from({ length: count }, (_unused, index) => ({
    startMs: index * stepMs,
    endMs: (index + 1) * stepMs,
    text: `第${index + 1}句`,
  }))
}

export function chunkFixtures(): ChunkTranscript[] {
  return [
    {
      startMs: 0,
      endMs: 10_000,
      sentences: [
        { startMs: 0, endMs: 5000, text: '甲' },
        { startMs: 5000, endMs: 10_000, text: '乙' },
      ],
    },
    {
      startMs: 10_000,
      endMs: 20_000,
      sentences: [{ startMs: 0, endMs: 4000, text: '丙' }],
    },
  ]
}
