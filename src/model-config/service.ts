import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { normalizeAsrBaseUrl } from '../asr/provider.js'
import type { AsrConfig, LlmConfig, LlmProtocol, LlmTuning } from '../config.js'
import { badRequest, conflict, notFound } from '../errors.js'
import { createEmbeddingProvider, postEmbeddingRequest } from '../kb/embedding.js'
import { createLlmClient, type LlmClient } from '../pipeline/llm.js'
import { taskPurpose, type LlmTaskKey } from '../ai/tasks.js'
import { decryptSecret, encryptSecret, maskSecret } from './crypto.js'

export const LLM_PURPOSES = ['content', 'embedding'] as const
export type LlmPurpose = (typeof LLM_PURPOSES)[number]

export type AsrProtocol = 'minimax' | 'openai'
export type { LlmProtocol }

export const EMBEDDING_DIMENSION = 1024

export interface LlmConfigDto {
  configId: string
  name: string
  provider: string
  protocol: LlmProtocol
  baseUrl: string
  model: string
  purpose: LlmPurpose
  apiKeyConfigured: boolean
  apiKeyMasked: string | null
  isDefault: boolean
  isActive: boolean
  inputPriceMicrosPer1k: number | null
  outputPriceMicrosPer1k: number | null
  lastTestedAt: number | null
  lastTestStatus: 'success' | 'failed' | null
  lastTestError: string | null
  createdAt: number
  updatedAt: number
}

export interface AsrConfigDto {
  provider: string
  protocol: AsrProtocol
  baseUrl: string
  model: string
  apiKeyConfigured: boolean
  apiKeyMasked: string | null
  enabled: boolean
  lastTestedAt: number | null
  lastTestStatus: 'success' | 'failed' | null
  lastTestError: string | null
  updatedAt: number
}

export interface ModelTestResult {
  status: 'success' | 'failed'
  detail: string
  testedAt: number
}

export interface LlmConfigInput {
  name: string
  provider: string
  protocol?: LlmProtocol
  baseUrl: string
  model: string
  purpose: LlmPurpose
  apiKey?: string
  isDefault?: boolean
  isActive?: boolean
  inputPriceMicrosPer1k?: number | null
  outputPriceMicrosPer1k?: number | null
}

export interface LlmConfigPatch {
  name?: string
  provider?: string
  protocol?: LlmProtocol
  baseUrl?: string
  model?: string
  purpose?: LlmPurpose
  apiKey?: string
  isDefault?: boolean
  isActive?: boolean
  inputPriceMicrosPer1k?: number | null
  outputPriceMicrosPer1k?: number | null
}

export interface AsrConfigPatch {
  provider?: string
  protocol?: AsrProtocol
  baseUrl?: string
  model?: string
  apiKey?: string
  enabled?: boolean
}

interface LlmRow {
  config_id: string
  name: string
  provider: string
  protocol: string
  base_url: string
  model: string
  api_key_encrypted: string | null
  purpose: string
  is_default: boolean
  is_active: boolean
  input_price_micros_per_1k: number | null
  output_price_micros_per_1k: number | null
  last_tested_at: Date | null
  last_test_status: 'success' | 'failed' | null
  last_test_error: string | null
  created_at: Date
  updated_at: Date
}

interface AsrRow {
  provider: string
  protocol: string
  base_url: string
  model: string
  api_key_encrypted: string | null
  enabled: boolean
  last_tested_at: Date | null
  last_test_status: 'success' | 'failed' | null
  last_test_error: string | null
  updated_at: Date
}

export interface ModelConfigOptions {
  encryptionKey: string
  asrTimeoutMs: number
  llmTuning: LlmTuning
}

export interface ResolvedLlm {
  configId: string
  provider: string
  client: LlmClient
  config: LlmConfig
  model: string
}

export interface ResolvedTaskLlm {
  primary?: ResolvedLlm
  fallback?: ResolvedLlm
}

function toMillis(value: Date | null): number | null {
  return value === null ? null : value.getTime()
}

/** 管理员可能粘贴完整端点，统一回退到 base URL，避免重复拼接路径。 */
function normalizeApiBase(raw: string): string {
  return raw.trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:v1\/)?chat\/completions$/i, '')
    .replace(/\/v1\/messages$/i, '')
    .replace(/\/embeddings$/i, '')
    .replace(/\/(?:v1\/)?audio\/transcriptions$/i, '')
    .replace(/\/(?:v1\/)?speech_to_text$/i, '')
}

function requireHttpUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw badRequest('baseUrl must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('baseUrl must be an absolute http(s) URL')
  }
  return normalizeApiBase(url.toString())
}

/** Anthropic Messages 没有 embeddings 端点，embedding 用途只能走 OpenAI 兼容协议。 */
function requireProtocolForPurpose(protocol: LlmProtocol, purpose: LlmPurpose): void {
  if (purpose === 'embedding' && protocol !== 'openai') {
    throw badRequest('embedding config requires the openai protocol')
  }
}

function errorDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

export class ModelConfigService {
  constructor(
    private readonly pool: Pool,
    private readonly options: ModelConfigOptions,
  ) {}

  async listLlm(): Promise<LlmConfigDto[]> {
    const { rows } = await this.pool.query<LlmRow>(
      `SELECT * FROM llm_configs ORDER BY is_default DESC, created_at DESC`,
    )
    return rows.map(row => this.toLlmDto(row))
  }

  async getLlm(configId: string): Promise<LlmConfigDto> {
    return this.toLlmDto(await this.getLlmRow(configId))
  }

  async createLlm(input: LlmConfigInput): Promise<LlmConfigDto> {
    const configId = `llmc_${randomBytes(8).toString('hex')}`
    const protocol = input.protocol ?? 'openai'
    requireProtocolForPurpose(protocol, input.purpose)
    const encrypted = input.apiKey === undefined || input.apiKey === ''
      ? null
      : encryptSecret(input.apiKey, this.options.encryptionKey)
    const isDefault = input.isDefault === true && input.isActive !== false
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (isDefault) {
        await client.query(
          `UPDATE llm_configs SET is_default = false, updated_at = now()
           WHERE purpose = $1 AND is_default`,
          [input.purpose],
        )
      }
      const { rows } = await client.query<LlmRow>(
        `INSERT INTO llm_configs
           (config_id, name, provider, protocol, base_url, model, api_key_encrypted,
            purpose, is_default, is_active, input_price_micros_per_1k, output_price_micros_per_1k)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          configId,
          input.name,
          input.provider,
          protocol,
          requireHttpUrl(input.baseUrl),
          input.model,
          encrypted,
          input.purpose,
          isDefault,
          input.isActive !== false,
          input.inputPriceMicrosPer1k ?? null,
          input.outputPriceMicrosPer1k ?? null,
        ],
      )
      await client.query('COMMIT')
      return this.toLlmDto(rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async updateLlm(configId: string, patch: LlmConfigPatch): Promise<LlmConfigDto> {
    const existing = await this.getLlmRow(configId)
    const purpose = patch.purpose ?? (existing.purpose as LlmPurpose)
    const protocol = patch.protocol ?? (existing.protocol as LlmProtocol)
    requireProtocolForPurpose(protocol, purpose)
    const becomesDefault = patch.isDefault === true
    const isActive = patch.isActive ?? existing.is_active
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (becomesDefault) {
        await client.query(
          `UPDATE llm_configs SET is_default = false, updated_at = now()
           WHERE purpose = $1 AND is_default AND config_id <> $2`,
          [purpose, configId],
        )
      }
      const encrypted = patch.apiKey === undefined || patch.apiKey === ''
        ? existing.api_key_encrypted
        : encryptSecret(patch.apiKey, this.options.encryptionKey)
      const { rows } = await client.query<LlmRow>(
        `UPDATE llm_configs SET
           name = COALESCE($2, name),
           provider = COALESCE($3, provider),
           protocol = $4,
           base_url = COALESCE($5, base_url),
           model = COALESCE($6, model),
           api_key_encrypted = $7,
           purpose = $8,
           is_default = $9,
           is_active = $10,
           input_price_micros_per_1k = $11,
           output_price_micros_per_1k = $12,
           updated_at = now()
         WHERE config_id = $1
         RETURNING *`,
        [
          configId,
          patch.name ?? null,
          patch.provider ?? null,
          protocol,
          patch.baseUrl === undefined ? null : requireHttpUrl(patch.baseUrl),
          patch.model ?? null,
          encrypted,
          purpose,
          becomesDefault ? true : (isActive ? existing.is_default && purpose === existing.purpose : false),
          isActive,
          patch.inputPriceMicrosPer1k === undefined
            ? existing.input_price_micros_per_1k
            : patch.inputPriceMicrosPer1k,
          patch.outputPriceMicrosPer1k === undefined
            ? existing.output_price_micros_per_1k
            : patch.outputPriceMicrosPer1k,
        ],
      )
      await client.query('COMMIT')
      return this.toLlmDto(rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async deleteLlm(configId: string): Promise<void> {
    const existing = await this.getLlmRow(configId)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM llm_configs WHERE config_id = $1', [configId])
      if (existing.is_default) {
        await client.query(
          `UPDATE llm_configs SET is_default = true, updated_at = now()
           WHERE config_id = (
             SELECT config_id FROM llm_configs
             WHERE purpose = $1 AND is_active
             ORDER BY created_at LIMIT 1
           )`,
          [existing.purpose],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async setDefaultLlm(configId: string): Promise<LlmConfigDto> {
    const existing = await this.getLlmRow(configId)
    if (!existing.is_active) throw conflict('config is disabled')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE llm_configs SET is_default = false, updated_at = now()
         WHERE purpose = $1 AND is_default AND config_id <> $2`,
        [existing.purpose, configId],
      )
      const { rows } = await client.query<LlmRow>(
        `UPDATE llm_configs SET is_default = true, is_active = true, updated_at = now()
         WHERE config_id = $1 RETURNING *`,
        [configId],
      )
      await client.query('COMMIT')
      return this.toLlmDto(rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async testLlm(configId: string): Promise<ModelTestResult> {
    const row = await this.getLlmRow(configId)
    const result = await this.probeLlm(row)
    await this.recordLlmTest(configId, result)
    return result
  }

  async getAsr(): Promise<AsrConfigDto> {
    return this.toAsrDto(await this.ensureAsrRow())
  }

  async updateAsr(patch: AsrConfigPatch): Promise<AsrConfigDto> {
    await this.ensureAsrRow()
    const encrypted = patch.apiKey === undefined || patch.apiKey === ''
      ? undefined
      : encryptSecret(patch.apiKey, this.options.encryptionKey)
    const { rows } = await this.pool.query<AsrRow>(
      `UPDATE asr_config SET
         provider = COALESCE($1, provider),
         protocol = COALESCE($2, protocol),
         base_url = COALESCE($3, base_url),
         model = COALESCE($4, model),
         api_key_encrypted = COALESCE($5, api_key_encrypted),
         enabled = COALESCE($6, enabled),
         updated_at = now()
       WHERE id = 1
       RETURNING *`,
      [
        patch.provider ?? null,
        patch.protocol ?? null,
        patch.baseUrl === undefined ? null : requireHttpUrl(patch.baseUrl),
        patch.model ?? null,
        encrypted ?? null,
        patch.enabled ?? null,
      ],
    )
    return this.toAsrDto(rows[0]!)
  }

  async testAsr(): Promise<ModelTestResult> {
    const row = await this.ensureAsrRow()
    const result = await this.probeAsr(row)
    await this.pool.query(
      `UPDATE asr_config
       SET last_tested_at = now(), last_test_status = $1, last_test_error = $2, updated_at = now()
       WHERE id = 1`,
      [result.status, result.status === 'success' ? null : result.detail],
    )
    return result
  }

  async resolveAsr(): Promise<AsrConfig | undefined> {
    const row = await this.ensureAsrRow()
    if (!row.enabled || row.api_key_encrypted === null) return undefined
    const apiKey = this.decryptOrUndefined(row.api_key_encrypted)
    if (apiKey === undefined) return undefined
    return {
      protocol: row.protocol === 'openai' ? 'openai' : 'minimax',
      baseUrl: row.base_url,
      apiKey,
      model: row.model,
      timeoutMs: this.options.asrTimeoutMs,
    }
  }

  async resolveLlm(purpose: LlmPurpose): Promise<ResolvedLlm | undefined> {
    const { rows } = await this.pool.query<LlmRow>(
      `SELECT * FROM llm_configs
       WHERE purpose = $1 AND is_default AND is_active
       LIMIT 1`,
      [purpose],
    )
    const row = rows[0]
    return row === undefined ? undefined : this.toResolvedLlm(row)
  }

  /** 任务绑定优先；绑定失效（停用/用途不符）时回落默认模型，保证既有部署不受影响。 */
  async resolveTaskModels(taskKey: LlmTaskKey): Promise<ResolvedTaskLlm> {
    const purpose = taskPurpose(taskKey)
    const { rows } = await this.pool.query<{
      primary_config_id: string
      fallback_config_id: string | null
    }>(
      'SELECT primary_config_id, fallback_config_id FROM llm_task_bindings WHERE task_key = $1',
      [taskKey],
    )
    const binding = rows[0]
    if (binding !== undefined) {
      const primary = await this.resolveConfig(binding.primary_config_id, purpose)
      const fallback = binding.fallback_config_id === null
        ? undefined
        : await this.resolveConfig(binding.fallback_config_id, purpose)
      if (primary !== undefined) return { primary, ...(fallback === undefined ? {} : { fallback }) }
      if (fallback !== undefined) return { primary: fallback }
    }
    const primary = await this.resolveLlm(purpose)
    return primary === undefined ? {} : { primary }
  }

  private toResolvedLlm(row: LlmRow): ResolvedLlm | undefined {
    const apiKey = row.api_key_encrypted === null
      ? undefined
      : this.decryptOrUndefined(row.api_key_encrypted)
    if (row.api_key_encrypted !== null && apiKey === undefined) return undefined
    const config: LlmConfig = {
      protocol: row.protocol === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: row.base_url,
      model: row.model,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...this.options.llmTuning,
    }
    return {
      configId: row.config_id,
      provider: row.provider,
      client: createLlmClient(config),
      config,
      model: row.model,
    }
  }

  private async resolveConfig(configId: string, purpose: LlmPurpose): Promise<ResolvedLlm | undefined> {
    const { rows } = await this.pool.query<LlmRow>(
      'SELECT * FROM llm_configs WHERE config_id = $1 AND is_active AND purpose = $2',
      [configId, purpose],
    )
    const row = rows[0]
    return row === undefined ? undefined : this.toResolvedLlm(row)
  }

  async resolveEmbedding(): Promise<((text: string) => Promise<number[]>) | undefined> {
    const resolved = await this.resolveLlm('embedding')
    return resolved === undefined ? undefined : createEmbeddingProvider(resolved.config)
  }

  async hasEmbedding(): Promise<boolean> {
    return (await this.resolveLlm('embedding')) !== undefined
  }

  private decryptOrUndefined(token: string): string | undefined {
    try {
      return decryptSecret(token, this.options.encryptionKey)
    } catch {
      return undefined
    }
  }

  private async getLlmRow(configId: string): Promise<LlmRow> {
    const { rows } = await this.pool.query<LlmRow>(
      'SELECT * FROM llm_configs WHERE config_id = $1',
      [configId],
    )
    const row = rows[0]
    if (row === undefined) throw notFound('model config not found')
    return row
  }

  private toLlmDto(row: LlmRow): LlmConfigDto {
    const plain = row.api_key_encrypted === null
      ? undefined
      : this.decryptOrUndefined(row.api_key_encrypted)
    return {
      configId: row.config_id,
      name: row.name,
      provider: row.provider,
      protocol: row.protocol === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: row.base_url,
      model: row.model,
      purpose: row.purpose as LlmPurpose,
      apiKeyConfigured: row.api_key_encrypted !== null,
      apiKeyMasked: row.api_key_encrypted === null
        ? null
        : plain === undefined ? '[无法解密，请重新录入]' : maskSecret(plain),
      isDefault: row.is_default,
      isActive: row.is_active,
      inputPriceMicrosPer1k: row.input_price_micros_per_1k,
      outputPriceMicrosPer1k: row.output_price_micros_per_1k,
      lastTestedAt: toMillis(row.last_tested_at),
      lastTestStatus: row.last_test_status,
      lastTestError: row.last_test_error,
      createdAt: row.created_at.getTime(),
      updatedAt: row.updated_at.getTime(),
    }
  }

  private async ensureAsrRow(): Promise<AsrRow> {
    await this.pool.query('INSERT INTO asr_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING')
    const { rows } = await this.pool.query<AsrRow>('SELECT * FROM asr_config WHERE id = 1')
    return rows[0]!
  }

  private toAsrDto(row: AsrRow): AsrConfigDto {
    const plain = row.api_key_encrypted === null
      ? undefined
      : this.decryptOrUndefined(row.api_key_encrypted)
    return {
      provider: row.provider,
      protocol: row.protocol === 'openai' ? 'openai' : 'minimax',
      baseUrl: row.base_url,
      model: row.model,
      apiKeyConfigured: row.api_key_encrypted !== null,
      apiKeyMasked: row.api_key_encrypted === null
        ? null
        : plain === undefined ? '[无法解密，请重新录入]' : maskSecret(plain),
      enabled: row.enabled,
      lastTestedAt: toMillis(row.last_tested_at),
      lastTestStatus: row.last_test_status,
      lastTestError: row.last_test_error,
      updatedAt: row.updated_at.getTime(),
    }
  }

  private async recordLlmTest(configId: string, result: ModelTestResult): Promise<void> {
    await this.pool.query(
      `UPDATE llm_configs
       SET last_tested_at = $2, last_test_status = $3, last_test_error = $4, updated_at = now()
       WHERE config_id = $1`,
      [configId, new Date(result.testedAt), result.status, result.status === 'success' ? null : result.detail],
    )
  }

  private async probeLlm(row: LlmRow): Promise<ModelTestResult> {
    const testedAt = Date.now()
    const apiKey = row.api_key_encrypted === null
      ? undefined
      : this.decryptOrUndefined(row.api_key_encrypted)
    if (row.api_key_encrypted !== null && apiKey === undefined) {
      return { status: 'failed', detail: '已存密钥无法解密，请重新录入', testedAt }
    }
    const base = normalizeApiBase(row.base_url)
    const anthropic = row.protocol === 'anthropic'
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (apiKey !== undefined) {
      headers.authorization = `Bearer ${apiKey}`
      if (anthropic) headers['x-api-key'] = apiKey
    }
    if (anthropic) headers['anthropic-version'] = '2023-06-01'

    if (row.purpose === 'embedding') {
      let response: Response
      try {
        response = await postEmbeddingRequest(
          { baseUrl: base, model: row.model, ...(apiKey === undefined ? {} : { apiKey }) },
          { model: row.model, input: ['ping'] },
          15_000,
        )
      } catch (error) {
        return { status: 'failed', detail: errorDetail(error), testedAt }
      }
      if (!response.ok) return { status: 'failed', detail: `HTTP ${response.status}`, testedAt }
      const payload: unknown = await response.json().catch(() => undefined)
      const dims = Array.isArray((payload as { data?: unknown })?.data)
        ? ((payload as { data: { embedding?: unknown }[] }).data[0]?.embedding)
        : undefined
      if (!Array.isArray(dims)) {
        return { status: 'failed', detail: '响应缺少 embedding 字段', testedAt }
      }
      if (dims.length !== EMBEDDING_DIMENSION) {
        return {
          status: 'failed',
          detail: `向量维度 ${dims.length}，必须为 ${EMBEDDING_DIMENSION}`,
          testedAt,
        }
      }
      return { status: 'success', detail: `模型 ${row.model} 连通正常（${dims.length} 维）`, testedAt }
    }

    let response: Response
    try {
      response = await fetch(`${base}${anthropic ? '/v1/messages' : '/chat/completions'}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: row.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      return { status: 'failed', detail: errorDetail(error), testedAt }
    }
    if (!response.ok) return { status: 'failed', detail: `HTTP ${response.status}`, testedAt }
    return { status: 'success', detail: `模型 ${row.model} 连通正常`, testedAt }
  }

  private async probeAsr(row: AsrRow): Promise<ModelTestResult> {
    const testedAt = Date.now()
    const apiKey = row.api_key_encrypted === null
      ? undefined
      : this.decryptOrUndefined(row.api_key_encrypted)
    if (apiKey === undefined) {
      return { status: 'failed', detail: 'API Key 未配置或无法解密', testedAt }
    }

    const endpoint = row.protocol === 'openai'
      ? `${normalizeApiBase(row.base_url)}/audio/transcriptions`
      : `${normalizeAsrBaseUrl(row.base_url)}/v1/speech_to_text`
    const form = new FormData()
    form.append('file', new Blob([sampleWav()], { type: 'audio/wav' }), 'sample.wav')
    form.append('model', row.model)
    form.append('response_format', 'json')
    if (row.protocol !== 'openai') form.append('timestamp_level', 'sentence')

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      return { status: 'failed', detail: errorDetail(error), testedAt }
    }
    if (!response.ok) return { status: 'failed', detail: `HTTP ${response.status}`, testedAt }

    if (row.protocol !== 'openai') {
      const payload: unknown = await response.json().catch(() => undefined)
      const baseResp = (payload as { base_resp?: { status_code?: unknown } } | undefined)?.base_resp
      if (baseResp !== undefined && baseResp.status_code !== 0) {
        return {
          status: 'failed',
          detail: `转写接口业务错误 ${String(baseResp.status_code)}`,
          testedAt,
        }
      }
    }
    return { status: 'success', detail: `模型 ${row.model} 连通正常`, testedAt }
  }
}

/** 1 秒 440Hz 16k 单声道 16bit WAV；连接测试即用即弃。 */
function sampleWav(): Buffer {
  const sampleRate = 16_000
  const samples = sampleRate
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(0.3 * 32767 * Math.sin(2 * Math.PI * 440 * i / sampleRate)), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
