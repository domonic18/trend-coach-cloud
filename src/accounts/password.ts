import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const PARAMS = { N: 16_384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 }

function derive(password: string, salt: Buffer, params: typeof PARAMS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem }, (error, key) => {
      if (error !== null) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, PARAMS)
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

/** 格式或参数不合法一律视为验证失败，避免异常泄露内部细节。 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (stored === null) return false
  const [algorithm, n, r, p, saltText, keyText] = stored.split('$')
  if (algorithm !== 'scrypt' || n === undefined || r === undefined || p === undefined) return false
  const params = { ...PARAMS, N: Number(n), r: Number(r), p: Number(p) }
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltText ?? '', 'base64')
    expected = Buffer.from(keyText ?? '', 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length !== params.keylen) return false
  const actual = await derive(password, salt, params)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
