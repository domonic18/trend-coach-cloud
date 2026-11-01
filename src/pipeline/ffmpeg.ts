import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { parseSilences, type SilenceInterval } from './silence.js'
import type { SourceProbe } from './types.js'

const STDERR_LIMIT = 256 * 1024

export type MediaToolFailure = 'unavailable' | 'timeout' | 'canceled' | 'failed'

export class MediaToolError extends Error {
  constructor(readonly reason: MediaToolFailure) {
    super(`media tool ${reason}`)
    this.name = 'MediaToolError'
  }
}

export type SourceInvalidReason = 'invalid' | 'missing_video' | 'missing_audio' | 'too_long'

export class SourceProbeError extends Error {
  constructor(readonly reason: SourceInvalidReason) {
    super(`source ${reason}`)
    this.name = 'SourceProbeError'
  }
}

export interface FfmpegToolPaths {
  ffmpegPath: string
  ffprobePath: string
}

export interface CommandOptions {
  timeoutMs: number
  signal?: AbortSignal
  onStdout?: (text: string) => void
}

interface CommandResult {
  stdout: string
  stderr: string
}

/** 参数数组 + 无 shell；stderr 可能含源路径，只用于解析，不落日志。 */
export function runMediaTool(
  file: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      reject(new MediaToolError('unavailable'))
      return
    }

    let settled = false
    let timer: NodeJS.Timeout | undefined
    let stdout = ''
    const stderrChunks: Buffer[] = []
    let stderrBytes = 0

    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    function fail(reason: MediaToolFailure): void {
      if (settled) return
      settled = true
      cleanup()
      child.kill('SIGKILL')
      reject(new MediaToolError(reason))
    }

    function onAbort(): void {
      fail('canceled')
    }

    if (options.signal?.aborted === true) {
      fail('canceled')
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => fail('timeout'), options.timeoutMs)

    child.on('error', () => fail('unavailable'))
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdout += text
      options.onStdout?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      stderrChunks.push(chunk)
      while (stderrBytes > STDERR_LIMIT && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()
        if (removed !== undefined) stderrBytes -= removed.length
      }
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      cleanup()
      if (code === 0) {
        resolve({ stdout, stderr: Buffer.concat(stderrChunks).toString('utf8') })
      } else {
        reject(new MediaToolError('failed'))
      }
    })
  })
}

export async function checkMediaTools(tools: FfmpegToolPaths, timeoutMs = 5000): Promise<void> {
  await runMediaTool(tools.ffmpegPath, ['-version'], { timeoutMs })
  await runMediaTool(tools.ffprobePath, ['-version'], { timeoutMs })
}

export async function probeSource(
  tools: FfmpegToolPaths,
  inputPath: string,
  options: { timeoutMs: number; maxSeconds: number; signal?: AbortSignal },
): Promise<SourceProbe> {
  const command: CommandOptions = {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const { stdout } = await runMediaTool(
    tools.ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath],
    command,
  )

  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new SourceProbeError('invalid')
  }
  if (typeof payload !== 'object' || payload === null) throw new SourceProbeError('invalid')
  const record = payload as Record<string, unknown>
  const streams = Array.isArray(record.streams) ? record.streams : []
  const streamsOf = (type: string): Record<string, unknown>[] => streams.filter((stream): stream is Record<string, unknown> => (
    typeof stream === 'object' && stream !== null && (stream as Record<string, unknown>).codec_type === type
  ))

  const video = streamsOf('video')[0]
  if (video === undefined) throw new SourceProbeError('missing_video')
  const audio = streamsOf('audio')[0]
  if (audio === undefined) throw new SourceProbeError('missing_audio')

  const format = typeof record.format === 'object' && record.format !== null
    ? record.format as Record<string, unknown>
    : {}
  const durationSec = Number(format.duration ?? video.duration ?? audio.duration)
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new SourceProbeError('invalid')
  if (durationSec > options.maxSeconds) throw new SourceProbeError('too_long')

  const width = Number(video.width)
  const height = Number(video.height)
  return {
    durationMs: Math.round(durationSec * 1000),
    videoCodec: String(video.codec_name ?? 'unknown'),
    audioCodec: String(audio.codec_name ?? 'unknown'),
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
  }
}

export async function transcodeToHls(
  tools: FfmpegToolPaths,
  inputPath: string,
  outputDir: string,
  options: { timeoutMs: number; signal?: AbortSignal; onProgress?: (outMs: number) => void },
): Promise<void> {
  let progress = ''
  const args = [
    '-hide_banner',
    '-nostats',
    '-progress', 'pipe:1',
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-vf', "scale='min(1280,iw)':-2",
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', join(outputDir, 'seg_%05d.ts'),
    join(outputDir, 'index.m3u8'),
  ]
  await runMediaTool(tools.ffmpegPath, args, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onStdout: text => {
      progress += text
      const lines = progress.split('\n')
      progress = lines.pop() ?? ''
      for (const line of lines) {
        const match = /^out_time_ms=(\d+)$/.exec(line.trim())
        if (match?.[1] !== undefined) options.onProgress?.(Math.round(Number(match[1]) / 1000))
      }
    },
  })
}

export async function extractWav(
  tools: FfmpegToolPaths,
  inputPath: string,
  outputPath: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  await runMediaTool(
    tools.ffmpegPath,
    ['-hide_banner', '-nostats', '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath],
    {
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )
}

/** 关键帧至少 800px，长边不超过 2000px；小分辨率源按需放大以满足图示下限。 */
export async function extractFrame(
  tools: FfmpegToolPaths,
  inputPath: string,
  outputPath: string,
  options: { atSec: number; timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  await runMediaTool(
    tools.ffmpegPath,
    [
      '-hide_banner', '-nostats', '-y',
      '-ss', Math.max(0, options.atSec).toFixed(3),
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', "scale='if(gte(iw,ih),-2,max(800,min(2000,iw)))':'if(gte(iw,ih),max(800,min(2000,ih)),-2)'",
      '-q:v', '2',
      outputPath,
    ],
    {
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )
}

export async function detectSilences(
  tools: FfmpegToolPaths,
  wavPath: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<SilenceInterval[]> {
  const { stderr } = await runMediaTool(
    tools.ffmpegPath,
    ['-hide_banner', '-nostats', '-i', wavPath, '-af', 'silencedetect=noise=-30dB:d=0.5', '-f', 'null', '-'],
    {
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )
  return parseSilences(stderr)
}

export async function cutAudioChunk(
  tools: FfmpegToolPaths,
  wavPath: string,
  outputPath: string,
  range: { startMs: number; endMs: number },
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  const startSec = (range.startMs / 1000).toFixed(3)
  const durationSec = ((range.endMs - range.startMs) / 1000).toFixed(3)
  await runMediaTool(
    tools.ffmpegPath,
    [
      '-hide_banner', '-nostats', '-y',
      '-ss', startSec,
      '-t', durationSec,
      '-i', wavPath,
      '-c:a', 'pcm_s16le', '-ac', '1', '-ar', '16000',
      outputPath,
    ],
    {
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )
}
