import type { EmbeddingConfig } from '../config.js'
import { serviceUnavailable } from '../errors.js'

export const EMBEDDING_DIM = 1024

/** OpenAI 兼容的 /embeddings 端点；维度必须与迁移中的 halfvec(1024) 一致。 */
export function createEmbeddingProvider(
  config: EmbeddingConfig,
): (text: string) => Promise<number[]> {
  return async (text: string) => {
    const response = await fetch(`${config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
      },
      body: JSON.stringify({ model: config.model, input: text }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)
    if (response === undefined || !response.ok) throw serviceUnavailable('embedding service unavailable')
    const payload: unknown = await response.json().catch(() => undefined)
    const embedding = extractEmbedding(payload)
    if (embedding === undefined) throw serviceUnavailable('embedding response invalid')
    return embedding
  }
}

function extractEmbedding(payload: unknown): number[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) return undefined
  const first = data[0]
  if (typeof first !== 'object' || first === null) return undefined
  const embedding = (first as { embedding?: unknown }).embedding
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) return undefined
  return embedding.every(value => typeof value === 'number' && Number.isFinite(value))
    ? (embedding as number[])
    : undefined
}

export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}
