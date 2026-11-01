import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'

function keyOf(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

/** AES-256-GCM：`v1:<iv>:<tag>:<ciphertext>`，全部 base64url，便于单列存储。 */
export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, keyOf(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':')
}

export function decryptSecret(token: string, secret: string): string {
  const [version, ivRaw, tagRaw, dataRaw] = token.split(':')
  if (version !== VERSION || ivRaw === undefined || tagRaw === undefined || dataRaw === undefined) {
    throw new Error('unsupported secret format')
  }
  const decipher = createDecipheriv(ALGORITHM, keyOf(secret), Buffer.from(ivRaw, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/** 只回显前后各 4 位；短密钥整体打码，避免半串泄露。 */
export function maskSecret(plain: string): string {
  if (plain === '') return ''
  if (plain.length <= 8) return '*'.repeat(plain.length)
  return `${plain.slice(0, 4)}${'*'.repeat(Math.min(plain.length - 8, 8))}${plain.slice(-4)}`
}
