import type { ResolvedImage } from '../model-config/service.js'
import type { ImageFormat } from './image-size.js'

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const DEFAULT_SIZE = '2K'

export interface GeneratedImage {
  bytes: Buffer
  format: ImageFormat
}

export interface ImageClient {
  generate(prompt: string, options?: { signal?: AbortSignal }): Promise<GeneratedImage>
}

export class ImageProviderError extends Error {
  constructor(readonly kind: 'unavailable' | 'rate_limited' | 'invalid') {
    super(`image provider ${kind}`)
    this.name = 'ImageProviderError'
  }
}

function combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return external === undefined ? timeout : AbortSignal.any([timeout, external])
}

function formatOf(contentType: string | null, bytes: Buffer): ImageFormat | undefined {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase()
  if (normalized === 'image/png') return 'png'
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
  return undefined
}

async function download(url: string, signal: AbortSignal): Promise<GeneratedImage> {
  let response: Response
  try {
    response = await fetch(url, { signal, redirect: 'follow' })
  } catch {
    throw new ImageProviderError('unavailable')
  }
  if (!response.ok) throw new ImageProviderError('unavailable')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new ImageProviderError('invalid')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new ImageProviderError('invalid')
  const format = formatOf(response.headers.get('content-type'), bytes)
  if (format === undefined) throw new ImageProviderError('invalid')
  return { bytes, format }
}

/** 火山方舟文生图走 OpenAI 兼容的 /images/generations，返回短时 URL 后自行下载。 */
export function createArkImageClient(resolved: ResolvedImage, timeoutMs: number): ImageClient {
  const endpoint = `${resolved.baseUrl.replace(/\/+$/, '')}/images/generations`
  return {
    async generate(prompt, options) {
      const signal = combineSignals(timeoutMs, options?.signal)
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${resolved.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: resolved.model,
            prompt,
            size: DEFAULT_SIZE,
            response_format: 'url',
            watermark: false,
          }),
          signal,
        })
      } catch {
        throw new ImageProviderError('unavailable')
      }
      if (response.status === 429) throw new ImageProviderError('rate_limited')
      if (!response.ok) throw new ImageProviderError('unavailable')
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new ImageProviderError('invalid')
      }
      const data = typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>).data
        : undefined
      const first = Array.isArray(data) ? data[0] : undefined
      const url = typeof first === 'object' && first !== null
        ? (first as Record<string, unknown>).url
        : undefined
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new ImageProviderError('invalid')
      return download(url, signal)
    },
  }
}
