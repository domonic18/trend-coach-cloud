import type { EmbeddingConfig } from '../config.js'
import { serviceUnavailable } from '../errors.js'

export const EMBEDDING_DIM = 1024

/** 按当前后台配置解析；未配置或已停用时返回 undefined，调用方退化为纯词法。 */
export interface EmbeddingResolver {
  resolve(): Promise<((text: string) => Promise<number[]>) | undefined>
}

/**
 * 显式请求 1024 维：部分模型（如智谱 embedding-3）默认更高维，不传会与 halfvec(1024) 不符。
 * 不支持 dimensions 参数的模型会以 4xx 拒绝，此时重试一次不带该参数。
 */
export async function postEmbeddingRequest(
  config: EmbeddingConfig,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  const send = (payload: Record<string, unknown>) => fetch(`${config.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const response = await send({ ...body, dimensions: EMBEDDING_DIM })
  return response.status === 400 || response.status === 422 ? send(body) : response
}

/** OpenAI 兼容的 /embeddings 端点；维度必须与迁移中的 halfvec(1024) 一致。 */
export function createEmbeddingProvider(
  config: EmbeddingConfig,
): (text: string) => Promise<number[]> {
  return async (text: string) => {
    const response = await postEmbeddingRequest(config, { model: config.model, input: text }, 5_000)
      .catch(() => undefined)
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
