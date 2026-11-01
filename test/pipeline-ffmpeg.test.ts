import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { checkMediaTools, runMediaTool } from '../src/pipeline/ffmpeg.js'
import { createLocalMediaProcessor } from '../src/pipeline/media-processor.js'
import { createLocalMediaStore } from '../src/pipeline/media-store.js'

const enabled = process.env.RUN_FFMPEG_TESTS === '1'
const skip = enabled ? false : 'set RUN_FFMPEG_TESTS=1 to run real ffmpeg tests'

const tools = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }
let root = ''

before(async () => {
  if (!enabled) return
  root = await mkdtemp(join(tmpdir(), 'trend-coach-ffmpeg-'))
})

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

test('真实 ffmpeg：探测、HLS 转码、抽音频、切块与发布', { skip, timeout: 180_000 }, async () => {
  await checkMediaTools(tools)

  const source = join(root, 'source.mp4')
  await runMediaTool(tools.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    source,
  ], { timeoutMs: 60_000 })

  const store = createLocalMediaStore({
    storageDir: join(root, 'storage'),
    hlsDir: join(root, 'hls'),
  })
  const processor = createLocalMediaProcessor({ store, tools, maxSourceSeconds: 60 })
  const assetId = 'asset-ffmpeg-test'

  const written = await store.writeSource(assetId, createReadStream(source), { limitBytes: 100 * 1024 * 1024 })
  assert.ok(written.sizeBytes > 0)

  const probe = await processor.probe(assetId, { timeoutMs: 30_000 })
  assert.ok(probe.durationMs >= 7000 && probe.durationMs <= 9000, String(probe.durationMs))
  assert.equal(probe.width, 320)
  assert.equal(probe.height, 240)

  let maxProgress = 0
  await processor.transcode(assetId, {
    timeoutMs: 120_000,
    onProgress: outMs => {
      maxProgress = Math.max(maxProgress, outMs)
    },
  })
  assert.ok(maxProgress > 0)

  const workPlaylist = await readFile(join(store.workDir(assetId), 'hls', 'index.m3u8'), 'utf8')
  assert.match(workPlaylist, /#EXT-X-ENDLIST/)
  await processor.publish(assetId)
  await access(join(store.hlsOutputDir(assetId), 'index.m3u8'))

  await processor.extractAudio(assetId, { timeoutMs: 60_000 })
  await access(join(store.workDir(assetId), 'audio.wav'))
  const silences = await processor.detectSilences(assetId, { timeoutMs: 60_000 })
  assert.ok(Array.isArray(silences))

  const chunk = await processor.cutChunk(assetId, 0, { startMs: 0, endMs: 3000 }, { timeoutMs: 30_000 })
  const chunkSize = (await readFile(chunk)).length
  assert.ok(chunkSize > 0)

  await store.removeWork(assetId)
  await store.removeSource(assetId)
})
