import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  HlsIncompleteError,
  SourceChecksumError,
  SourceTooLargeError,
  createLocalMediaStore,
} from '../src/pipeline/media-store.js'

let root = ''

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'trend-coach-store-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

function store() {
  return createLocalMediaStore({
    storageDir: join(root, 'storage'),
    hlsDir: join(root, 'hls'),
  })
}

async function* chunks(...parts: string[]): AsyncIterable<Buffer> {
  for (const part of parts) yield Buffer.from(part)
}

async function writeHlsWork(dir: string, options: { endlist?: boolean; segment?: boolean } = {}): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.m3u8'), [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.0,',
    'seg_00000.ts',
    ...(options.endlist === false ? [] : ['#EXT-X-ENDLIST']),
    '',
  ].join('\n'))
  if (options.segment !== false) await writeFile(join(dir, 'seg_00000.ts'), Buffer.alloc(8, 1))
}

test('源文件流式写入并计算大小与 sha256', async () => {
  const media = store()
  const assetId = 'asset-store-write'
  const written = await media.writeSource(assetId, chunks('abc', 'def'), { limitBytes: 100 })
  assert.equal(written.sizeBytes, 6)
  assert.equal(written.sha256, createHash('sha256').update('abcdef').digest('hex'))
  assert.equal(written.relPath, `sources/${assetId}/source`)
  assert.equal(await readFile(media.sourcePath(assetId), 'utf8'), 'abcdef')
  assert.equal(await media.sourceSize(assetId), 6)
})

test('超限与校验和不符时删除半成品', async () => {
  const media = store()
  await assert.rejects(
    media.writeSource('asset-store-limit', chunks('123456'), { limitBytes: 5 }),
    SourceTooLargeError,
  )
  assert.equal(await media.sourceSize('asset-store-limit'), null)

  await assert.rejects(
    media.writeSource('asset-store-sha', chunks('abcdef'), {
      limitBytes: 100,
      expectedSha256: '0'.repeat(64),
    }),
    SourceChecksumError,
  )
  assert.equal(await media.sourceSize('asset-store-sha'), null)
})

test('校验完整的 HLS 后原子移入媒体目录', async () => {
  const media = store()
  const assetId = 'asset-store-publish'
  await writeHlsWork(join(media.workDir(assetId), 'hls'))
  await media.publishHls(assetId)

  assert.equal(media.hlsRelPath(assetId), `hls/${assetId}/index.m3u8`)
  const playlist = await readFile(join(media.hlsOutputDir(assetId), 'index.m3u8'), 'utf8')
  assert.match(playlist, /#EXT-X-ENDLIST/)
  assert.equal((await readFile(join(media.hlsOutputDir(assetId), 'seg_00000.ts'))).length, 8)
  await assert.rejects(readFile(join(media.workDir(assetId), 'hls', 'index.m3u8')), /ENOENT/)
})

test('未收尾或缺分片的 HLS 拒绝发布', async () => {
  const media = store()
  const unfinished = 'asset-store-unfinished'
  await writeHlsWork(join(media.workDir(unfinished), 'hls'), { endlist: false })
  await assert.rejects(media.publishHls(unfinished), HlsIncompleteError)
  await assert.rejects(readFile(join(media.hlsOutputDir(unfinished), 'index.m3u8')), /ENOENT/)

  const missing = 'asset-store-missing'
  await writeHlsWork(join(media.workDir(missing), 'hls'), { segment: false })
  await assert.rejects(media.publishHls(missing), HlsIncompleteError)
})

test('清理源文件与工作区', async () => {
  const media = store()
  const assetId = 'asset-store-clean'
  await media.writeSource(assetId, chunks('abc'), { limitBytes: 10 })
  await media.ensureWork(assetId)
  await writeFile(join(media.workDir(assetId), 'audio.wav'), Buffer.alloc(4))

  await media.removeWork(assetId)
  await assert.rejects(readFile(join(media.workDir(assetId), 'audio.wav')), /ENOENT/)
  assert.equal(await media.sourceSize(assetId), 3)

  await media.removeSource(assetId)
  assert.equal(await media.sourceSize(assetId), null)
})
