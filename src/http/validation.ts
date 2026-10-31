import { badRequest } from '../errors.js'

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

interface StringOptions {
  min?: number
  max?: number
  pattern?: RegExp
}

/** 按 Unicode 码点计数，避免 emoji/代理对把长度算短。 */
export function codePointLength(value: string): number {
  return [...value].length
}

export function stringField(
  body: Record<string, unknown>,
  key: string,
  { min = 1, max = Number.MAX_SAFE_INTEGER, pattern }: StringOptions = {},
): string {
  const value = body[key]
  if (typeof value !== 'string') throw badRequest(`${key} must be a string`)
  if (pattern !== undefined && !pattern.test(value)) throw badRequest(`${key} invalid`)
  const length = codePointLength(value)
  if (length < min || length > max) throw badRequest(`${key} must be ${min}–${max} characters`)
  return value
}

export function optionalStringField(
  body: Record<string, unknown>,
  key: string,
  options: StringOptions = {},
): string | undefined {
  if (body[key] === undefined) return undefined
  return stringField(body, key, options)
}

export function intField(
  body: Record<string, unknown>,
  key: string,
  { min, max, fallback }: { min: number; max: number; fallback?: number },
): number {
  const value = body[key]
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key]
  if (typeof value !== 'boolean') throw badRequest(`${key} must be a boolean`)
  return value
}
