import assert from 'node:assert/strict'
import test from 'node:test'
import { planAudioChunks, planWindows } from '../src/pipeline/chunks.js'
import { buildOutlineDigest } from '../src/pipeline/generation.js'
import {
  chapterIdFor,
  draftSegmentIdFor,
  knowledgePointIdFor,
  randomId,
} from '../src/pipeline/ids.js'
import { parseChapterResponse } from '../src/pipeline/prompts.js'
import { parseSilences } from '../src/pipeline/silence.js'
import {
  joinText,
  locateExcerpt,
  normalizeForMatch,
  splitTextByChars,
  uniqueTitle,
} from '../src/pipeline/text.js'
import {
  groupTranscriptSegments,
  mergeChunkSentences,
  parseTimedSentences,
} from '../src/pipeline/transcript.js'
import {
  SILENCEDETECT_STDERR,
  VERBOSE_TRANSCRIPT,
  chunkFixtures,
  sentenceFixtures,
} from './pipeline-fixtures.js'

test('silencedetect 解析并合并重叠区间', () => {
  assert.deepEqual(parseSilences(SILENCEDETECT_STDERR), [
    { startMs: 5000, endMs: 9000 },
    { startMs: 20_000, endMs: 21_000 },
  ])
  assert.deepEqual(parseSilences('no silence here'), [])
})

test('音频切块：优先在静音中点切开，块长不超过上限', () => {
  assert.deepEqual(
    planAudioChunks({
      durationMs: 100_000,
      maxSec: 40,
      silences: [{ startMs: 35_000, endMs: 39_000 }],
    }),
    [
      { index: 0, startMs: 0, endMs: 37_000 },
      { index: 1, startMs: 37_000, endMs: 77_000 },
      { index: 2, startMs: 77_000, endMs: 100_000 },
    ],
  )

  const hardCuts = planAudioChunks({ durationMs: 100_000, maxSec: 40, silences: [] })
  assert.deepEqual(hardCuts.map(chunk => [chunk.startMs, chunk.endMs]), [
    [0, 40_000],
    [40_000, 80_000],
    [80_000, 100_000],
  ])

  const tooEarly = planAudioChunks({
    durationMs: 100_000,
    maxSec: 40,
    silences: [{ startMs: 5000, endMs: 9000 }],
  })
  assert.equal(tooEarly[0]?.endMs, 40_000)
  for (const chunk of tooEarly) assert.ok(chunk.endMs - chunk.startMs <= 40_000)
})

test('生成窗口按转写片段回退并保留重叠', () => {
  const windows = planWindows(sentenceFixtures(20, 10_000), { windowMs: 60_000 })
  assert.equal(windows.length, 6)
  assert.equal(windows[0]?.startMs, 0)
  assert.equal(windows[0]?.endMs, 60_000)
  assert.equal(windows[1]?.startMs, 30_000)
  assert.equal(windows[1]?.endMs, 90_000)
  assert.equal(windows[windows.length - 1]?.endMs, 200_000)
  assert.ok(windows.every(window => window.sentences.length > 0))
  assert.deepEqual(planWindows([], { windowMs: 60_000 }), [])
})

test('全局大纲摘要均匀采样且保持顺序', () => {
  const segments = Array.from({ length: 400 }, (_, index) => ({
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text: `句子${index}`,
  }))
  const digest = buildOutlineDigest(segments, 100)
  assert.equal(digest.length, 100)
  assert.equal(digest[0]?.text, '句子0')
  for (let index = 1; index < digest.length; index += 1) {
    assert.ok((digest[index]?.startMs ?? 0) > (digest[index - 1]?.startMs ?? 0))
  }
  assert.equal(buildOutlineDigest(segments, 500).length, 400)
})

test('全局大纲接受多章节并拒绝超限', () => {
  const titles = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ title: `章节${index + 1}` }))
  assert.equal(parseChapterResponse({ chapters: titles(8) }).length, 8)
  assert.throws(() => parseChapterResponse({ chapters: titles(11) }))
  assert.throws(() => parseChapterResponse({ chapters: [] }))
})

test('转写解析兼容秒/毫秒时间键与整段退化', () => {
  assert.deepEqual(parseTimedSentences(VERBOSE_TRANSCRIPT, 3000), [
    { startMs: 500, endMs: 1500, text: '第一段' },
    { startMs: 1500, endMs: 2400, text: '第二段' },
  ])
  assert.deepEqual(
    parseTimedSentences({ sentences: [{ start_ms: 100, end_ms: 900, text: ' 甲 ' }] }, 2000),
    [{ startMs: 100, endMs: 900, text: '甲' }],
  )
  assert.deepEqual(parseTimedSentences({ text: '整段' }, 1200), [
    { startMs: 0, endMs: 1200, text: '整段' },
  ])
  assert.deepEqual(parseTimedSentences({ segments: [{ text: '无时间' }] }, 1000), [])
  assert.deepEqual(parseTimedSentences(null, 1000), [])
  assert.deepEqual(
    parseTimedSentences({ segments: [{ start: 0, end: 9, text: '越界' }] }, 3000),
    [{ startMs: 0, endMs: 3000, text: '越界' }],
  )
})

test('块内时间戳合并为全局单调时间线', () => {
  assert.deepEqual(mergeChunkSentences(chunkFixtures()), [
    { startMs: 0, endMs: 5000, text: '甲' },
    { startMs: 5000, endMs: 10_000, text: '乙' },
    { startMs: 10_000, endMs: 14_000, text: '丙' },
  ])
  assert.deepEqual(mergeChunkSentences([]), [])
})

test('转写分组限制单段时长与文本长度', () => {
  const grouped = groupTranscriptSegments(sentenceFixtures(7, 5000), 30)
  assert.equal(grouped.length, 2)
  assert.equal(grouped[0]?.text, '第1句第2句第3句第4句第5句第6句')
  assert.equal(grouped[0]?.endMs, 30_000)
  assert.equal(grouped[1]?.startMs, 30_000)

  const long = '趋势交易需要耐心。'.repeat(800)
  const split = groupTranscriptSegments([{ startMs: 0, endMs: 90_000, text: long }], 30)
  assert.ok(split.length > 1)
  let cursor = 0
  let chars = 0
  for (const segment of split) {
    assert.equal(segment.startMs, cursor)
    assert.ok(segment.endMs > segment.startMs)
    assert.ok(segment.endMs - segment.startMs <= 30_000)
    cursor = segment.endMs
    chars += Array.from(segment.text).length
  }
  assert.equal(cursor, 90_000)
  assert.equal(chars, 7200)
})

test('文本锚定忽略空白与标点，跨句命中返回覆盖范围', () => {
  assert.equal(normalizeForMatch('成交量，确认！'), '成交量确认')
  const sentences = [
    { startMs: 0, endMs: 1000, text: '价格突破均线，' },
    { startMs: 1000, endMs: 2000, text: '成交量 确认。' },
  ]
  assert.deepEqual(locateExcerpt(sentences, '均线成交量'), { startMs: 0, endMs: 2000 })
  assert.deepEqual(locateExcerpt(sentences, '成交量确认'), { startMs: 1000, endMs: 2000 })
  assert.equal(locateExcerpt(sentences, '不存在的片段'), null)
  assert.equal(locateExcerpt(sentences, '  '), null)
})

test('文本拼接与按长度切分', () => {
  assert.equal(joinText('abc', 'def'), 'abc def')
  assert.equal(joinText('你好', '世界'), '你好世界')
  assert.equal(joinText('', 'x'), 'x')

  const chunks = splitTextByChars('第一句。第二句！第三句？', 5)
  assert.deepEqual(chunks, ['第一句。', '第二句！', '第三句？'])
  assert.equal(chunks.join(''), '第一句。第二句！第三句？')

  const hard = splitTextByChars('abcdefghij', 4)
  assert.deepEqual(hard, ['abcd', 'efgh', 'ij'])
  assert.ok(hard.every(chunk => Array.from(chunk).length <= 4))
})

test('标题去重追加序号且不超长', () => {
  const used = new Set<string>()
  assert.equal(uniqueTitle('趋势反转', used), '趋势反转')
  assert.equal(uniqueTitle('趋势反转', used), '趋势反转（2）')
  assert.equal(uniqueTitle('趋势反转', used), '趋势反转（3）')
  const long = uniqueTitle('好'.repeat(200), used)
  assert.equal(Array.from(long).length, 200)
})

test('管线 ID 格式与 apply 幂等', () => {
  assert.match(randomId('job'), /^job_[0-9a-f]{16}$/)
  assert.match(randomId('tr'), /^tr_[0-9a-f]{16}$/)
  assert.match(randomId('chunk'), /^chunk_[0-9a-f]{16}$/)
  assert.match(randomId('gen'), /^gen_[0-9a-f]{16}$/)
  assert.notEqual(randomId('job'), randomId('job'))

  const generationId = 'gen_0123456789abcdef'
  assert.equal(chapterIdFor(generationId, 'ch01'), chapterIdFor(generationId, 'ch01'))
  assert.match(chapterIdFor(generationId, 'ch01'), /^ch_[0-9a-f]{8}_ch01$/)
  assert.match(knowledgePointIdFor(generationId, 'kp01'), /^kp_[0-9a-f]{8}_kp01$/)
  const segmentId = draftSegmentIdFor(generationId, 'sg0001')
  assert.match(segmentId, /^seg-[A-Za-z0-9._-]{1,76}$/)
  assert.notEqual(chapterIdFor(generationId, 'ch01'), chapterIdFor('gen_fedcba9876543210', 'ch01'))
})
