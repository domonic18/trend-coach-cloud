import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

const ASSET_ID = /^[A-Za-z0-9._-]{1,64}$/
const SEGMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ts$/

export class SourceTooLargeError extends Error {
  constructor() {
    super('source exceeds upload limit')
    this.name = 'SourceTooLargeError'
  }
}

export class SourceChecksumError extends Error {
  constructor() {
    super('source checksum mismatch')
    this.name = 'SourceChecksumError'
  }
}

export class HlsIncompleteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HlsIncompleteError'
  }
}

export interface StoredSource {
  relPath: string
  sizeBytes: number
  sha256: string
}

export interface MediaStore {
  sourcePath(assetId: string): string
  workDir(assetId: string): string
  hlsOutputDir(assetId: string): string
  hlsRelPath(assetId: string): string
  ensureWork(assetId: string): Promise<void>
  writeSource(
    assetId: string,
    source: AsyncIterable<Buffer>,
    options: { limitBytes: number; expectedSha256?: string },
  ): Promise<StoredSource>
  publishHls(assetId: string): Promise<void>
  removeSource(assetId: string): Promise<void>
  removeWork(assetId: string): Promise<void>
  sourceSize(assetId: string): Promise<number | null>
}

export function createLocalMediaStore(config: { storageDir: string; hlsDir: string }): MediaStore {
  return new LocalMediaStore(config.storageDir, config.hlsDir)
}

class LocalMediaStore implements MediaStore {
  constructor(
    private readonly storageRoot: string,
    private readonly hlsRoot: string,
  ) {}

  sourcePath(assetId: string): string {
    return join(this.sourceDir(assetId), 'source')
  }

  workDir(assetId: string): string {
    return join(this.storageRoot, 'work', checkAssetId(assetId))
  }

  hlsOutputDir(assetId: string): string {
    return join(this.hlsRoot, 'hls', checkAssetId(assetId))
  }

  hlsRelPath(assetId: string): string {
    return `hls/${checkAssetId(assetId)}/index.m3u8`
  }

  async ensureWork(assetId: string): Promise<void> {
    await mkdir(this.workDir(assetId), { recursive: true })
  }

  async writeSource(
    assetId: string,
    source: AsyncIterable<Buffer>,
    options: { limitBytes: number; expectedSha256?: string },
  ): Promise<StoredSource> {
    const dir = this.sourceDir(assetId)
    await mkdir(dir, { recursive: true })
    const temp = join(dir, 'source.tmp')
    const hash = createHash('sha256')
    let sizeBytes = 0
    try {
      const handle = await open(temp, 'w')
      try {
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          sizeBytes += buffer.length
          if (sizeBytes > options.limitBytes) throw new SourceTooLargeError()
          hash.update(buffer)
          await handle.write(buffer)
        }
      } finally {
        await handle.close()
      }
      const sha256 = hash.digest('hex')
      if (options.expectedSha256 !== undefined && options.expectedSha256 !== sha256) {
        throw new SourceChecksumError()
      }
      await rename(temp, this.sourcePath(assetId))
      return { relPath: `sources/${assetId}/source`, sizeBytes, sha256 }
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  async publishHls(assetId: string): Promise<void> {
    const workHls = join(this.workDir(assetId), 'hls')
    await assertCompleteHls(workHls)
    const destination = this.hlsOutputDir(assetId)
    await mkdir(join(this.hlsRoot, 'hls'), { recursive: true })
    await rm(destination, { recursive: true, force: true })
    await rename(workHls, destination)
  }

  async removeSource(assetId: string): Promise<void> {
    await rm(this.sourceDir(assetId), { recursive: true, force: true })
  }

  async removeWork(assetId: string): Promise<void> {
    await rm(this.workDir(assetId), { recursive: true, force: true })
  }

  async sourceSize(assetId: string): Promise<number | null> {
    try {
      const info = await stat(this.sourcePath(assetId))
      return info.isFile() ? info.size : null
    } catch {
      return null
    }
  }

  private sourceDir(assetId: string): string {
    return join(this.storageRoot, 'sources', checkAssetId(assetId))
  }
}

function checkAssetId(assetId: string): string {
  if (!ASSET_ID.test(assetId)) throw new Error('invalid asset id')
  return assetId
}

/** 发布前校验 ENDLIST 与全部分片，避免把不完整目录暴露给 CDN。 */
export async function assertCompleteHls(dir: string): Promise<void> {
  let playlist: string
  try {
    playlist = await readFile(join(dir, 'index.m3u8'), 'utf8')
  } catch {
    throw new HlsIncompleteError('hls playlist missing')
  }
  if (!playlist.includes('#EXT-X-ENDLIST')) throw new HlsIncompleteError('hls playlist not finalized')

  const segments = playlist
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  if (segments.length === 0) throw new HlsIncompleteError('hls playlist has no segments')

  for (const segment of segments) {
    if (basename(segment) !== segment || !SEGMENT_NAME.test(segment)) {
      throw new HlsIncompleteError('hls segment path invalid')
    }
    try {
      const info = await stat(join(dir, segment))
      if (!info.isFile() || info.size === 0) throw new HlsIncompleteError('hls segment empty')
    } catch (error) {
      if (error instanceof HlsIncompleteError) throw error
      throw new HlsIncompleteError('hls segment missing')
    }
  }
}
