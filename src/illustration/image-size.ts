export type ImageFormat = 'jpeg' | 'png'

export interface ImageSize {
  format: ImageFormat
  width: number
  height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function parsePng(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 24) return undefined
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return undefined
  }
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return width > 0 && height > 0 ? { format: 'png', width, height } : undefined
}

function parseJpeg(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    // SOF0–SOF15，排除 DHT(C4)/JPG(C8)/DAC(CC)。
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = bytes.readUInt16BE(offset + 5)
      const width = bytes.readUInt16BE(offset + 7)
      return width > 0 && height > 0 ? { format: 'jpeg', width, height } : undefined
    }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

/** 只解析头部尺寸，不做完整解码；格式不认识直接判失败。 */
export function parseImageSize(bytes: Buffer): ImageSize | undefined {
  return parsePng(bytes) ?? parseJpeg(bytes)
}
