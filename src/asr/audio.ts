import { badRequest } from '../errors.js'
import { asObject, intField } from '../http/validation.js'

export const MAX_ASR_DURATION_MS = 60_000
export const MAX_TRANSCRIPT_CHARS = 2000

const SAMPLE_RATE = 16_000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16
const WAV_HEADER_BYTES = 44
const MAX_WAV_BYTES = WAV_HEADER_BYTES + (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) * MAX_ASR_DURATION_MS) / 1000
const MAX_BASE64_CHARS = Math.ceil(MAX_WAV_BYTES / 3) * 4
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const DURATION_TOLERANCE_MS = 1000

export interface AsrAudio {
  bytes: Uint8Array
  durationMs: number
}

export function parseAsrBody(body: unknown): AsrAudio {
  const object = asObject(body)
  if (object.format !== 'wav') throw badRequest('format must be wav')
  const durationMs = intField(object, 'durationMs', { min: 1, max: MAX_ASR_DURATION_MS })
  return decodeAsrAudio(object.audio, durationMs)
}

/** 与插件 Host 独立实现的第二道边界：只信任通过 RIFF/WAVE 与时长校验的数据。 */
function decodeAsrAudio(audio: unknown, durationMs: number): AsrAudio {
  if (typeof audio !== 'string' || audio.length === 0) throw badRequest('audio must be a non-empty string')
  if (audio.length > MAX_BASE64_CHARS || audio.length % 4 !== 0 || !BASE64_PATTERN.test(audio)) {
    throw badRequest('audio must be valid base64')
  }

  const bytes = Buffer.from(audio, 'base64')
  if (bytes.length < WAV_HEADER_BYTES) throw badRequest('audio is not a wav file')
  if (bytes.length > MAX_WAV_BYTES) throw badRequest('audio too large')
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw badRequest('audio is not a wav file')
  }

  let offset = 12
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined
  let dataBytes: number | undefined
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4)
    const chunkSize = bytes.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    if (chunkStart + chunkSize > bytes.length) throw badRequest('audio chunks out of bounds')
    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw badRequest('audio fmt chunk invalid')
      format = {
        audioFormat: bytes.readUInt16LE(chunkStart),
        channels: bytes.readUInt16LE(chunkStart + 2),
        sampleRate: bytes.readUInt32LE(chunkStart + 4),
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
      }
    } else if (chunkId === 'data') {
      dataBytes = chunkSize
    }
    offset = chunkStart + chunkSize + (chunkSize % 2)
  }

  if (format === undefined || dataBytes === undefined) throw badRequest('audio chunks missing')
  if (format.audioFormat !== 1 || format.channels !== CHANNELS
    || format.sampleRate !== SAMPLE_RATE || format.bitsPerSample !== BITS_PER_SAMPLE) {
    throw badRequest('audio must be 16kHz mono PCM16 wav')
  }

  const actualMs = (dataBytes / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8))) * 1000
  if (actualMs > MAX_ASR_DURATION_MS + DURATION_TOLERANCE_MS) throw badRequest('audio too long')
  if (Math.abs(actualMs - durationMs) > DURATION_TOLERANCE_MS) throw badRequest('duration mismatch')
  return { bytes, durationMs }
}
