import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageFormat } from './image-size.js'

const FIGURE_ID = /^fig_[A-Za-z0-9._-]{1,60}$/
const CANDIDATE_ID = /^cand_[A-Za-z0-9._-]{1,59}$/

export interface StoredFigureImage {
  relPath: string
  bytes: number
  sha256: string
}

export interface FigureStore {
  write(
    figureId: string,
    candidateId: string,
    format: ImageFormat,
    bytes: Buffer,
  ): Promise<StoredFigureImage>
  pathOf(relPath: string): string
}

export function createFigureStore(figureDir: string): FigureStore {
  return {
    async write(figureId, candidateId, format, bytes) {
      if (!FIGURE_ID.test(figureId) || !CANDIDATE_ID.test(candidateId)) {
        throw new Error('invalid figure path')
      }
      const dir = join(figureDir, figureId)
      await mkdir(dir, { recursive: true })
      const name = `${candidateId}.${format === 'png' ? 'png' : 'jpg'}`
      await writeFile(join(dir, name), bytes)
      return {
        relPath: `${figureId}/${name}`,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    },
    pathOf(relPath) {
      return join(figureDir, relPath)
    },
  }
}
