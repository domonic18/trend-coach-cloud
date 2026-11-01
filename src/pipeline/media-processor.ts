import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cutAudioChunk,
  detectSilences as detectSilencesCommand,
  extractWav,
  probeSource,
  transcodeToHls,
  type FfmpegToolPaths,
} from './ffmpeg.js'
import type { MediaStore } from './media-store.js'
import type { SilenceInterval } from './silence.js'
import type { SourceProbe } from './types.js'

export interface ProcessOptions {
  timeoutMs: number
  signal?: AbortSignal
}

export interface MediaProcessor {
  probe(assetId: string, options: ProcessOptions): Promise<SourceProbe>
  transcode(
    assetId: string,
    options: ProcessOptions & { onProgress?: (outMs: number) => void },
  ): Promise<void>
  extractAudio(assetId: string, options: ProcessOptions): Promise<void>
  detectSilences(assetId: string, options: ProcessOptions): Promise<SilenceInterval[]>
  cutChunk(assetId: string, index: number, range: { startMs: number; endMs: number }, options: ProcessOptions): Promise<string>
  publish(assetId: string): Promise<void>
}

export function createLocalMediaProcessor(input: {
  store: MediaStore
  tools: FfmpegToolPaths
  maxSourceSeconds: number
}): MediaProcessor {
  const { store, tools, maxSourceSeconds } = input
  const audioPath = (assetId: string): string => join(store.workDir(assetId), 'audio.wav')
  const chunkDir = (assetId: string): string => join(store.workDir(assetId), 'chunks')
  const hlsWorkDir = (assetId: string): string => join(store.workDir(assetId), 'hls')

  return {
    async probe(assetId, options) {
      return probeSource(tools, store.sourcePath(assetId), {
        timeoutMs: options.timeoutMs,
        maxSeconds: maxSourceSeconds,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    },

    async transcode(assetId, options) {
      await mkdir(hlsWorkDir(assetId), { recursive: true })
      await transcodeToHls(tools, store.sourcePath(assetId), hlsWorkDir(assetId), {
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      })
    },

    async extractAudio(assetId, options) {
      await extractWav(tools, store.sourcePath(assetId), audioPath(assetId), {
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    },

    async detectSilences(assetId, options) {
      return detectSilencesCommand(tools, audioPath(assetId), {
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    },

    async cutChunk(assetId, index, range, options) {
      const dir = chunkDir(assetId)
      await mkdir(dir, { recursive: true })
      const output = join(dir, `chunk_${String(index).padStart(4, '0')}.wav`)
      await cutAudioChunk(tools, audioPath(assetId), output, range, {
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      return output
    },

    async publish(assetId) {
      await store.publishHls(assetId)
    },
  }
}
