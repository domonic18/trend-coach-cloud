import type { FastifyInstance } from 'fastify'
import type { AccountService } from '../accounts/service.js'
import type { AppConfig } from '../config.js'
import { badRequest, tooManyRequests } from '../errors.js'
import { requireSession } from '../http/principal.js'
import { asObject, optionalStringField, stringField } from '../http/validation.js'
import type { RateLimiter } from '../rate-limit.js'
import {
  LLM_PURPOSES,
  ModelConfigService,
  type AsrProtocol,
  type LlmConfigInput,
  type LlmConfigPatch,
  type LlmProtocol,
  type LlmPurpose,
} from './service.js'

const CONFIG_ID = /^llmc_[0-9a-f]{16}$/
const PROVIDER = /^[A-Za-z0-9._-]{1,32}$/
const PROTOCOLS: readonly AsrProtocol[] = ['minimax', 'openai']
const LLM_PROTOCOLS: readonly LlmProtocol[] = ['openai', 'anthropic']

export interface ModelConfigRouteDeps {
  models: ModelConfigService
  accounts: AccountService
  config: AppConfig
  limiter: RateLimiter
}

function configIdParam(raw: string): string {
  if (!CONFIG_ID.test(raw)) throw badRequest('configId invalid')
  return raw
}

function purposeField(value: unknown): LlmPurpose {
  if (typeof value !== 'string' || !(LLM_PURPOSES as readonly string[]).includes(value)) {
    throw badRequest('purpose must be content or embedding')
  }
  return value as LlmPurpose
}

function protocolField(value: unknown): AsrProtocol {
  if (typeof value !== 'string' || !(PROTOCOLS as readonly string[]).includes(value)) {
    throw badRequest('protocol must be minimax or openai')
  }
  return value as AsrProtocol
}

function optionalLlmProtocol(value: unknown): LlmProtocol | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(LLM_PROTOCOLS as readonly string[]).includes(value)) {
    throw badRequest('protocol must be openai or anthropic')
  }
  return value as LlmProtocol
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw badRequest(`${key} must be a boolean`)
  return value
}

interface ConnectionFields {
  provider?: string
  baseUrl?: string
  model?: string
  apiKey?: string
}

/** 空字符串表示保留原密钥，因此不能用 min=1 的通用字符串校验。 */
function optionalApiKey(body: Record<string, unknown>): string | undefined {
  const value = body.apiKey
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw badRequest('apiKey must be a string')
  if ([...value].length > 500) throw badRequest('apiKey must be at most 500 characters')
  return value
}

/** 价格单位为「微美元/千 token」；null 表示未配置，成本估算不猜测。 */
function optionalPrice(body: Record<string, unknown>, key: string): number | null | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw badRequest(`${key} must be a non-negative integer`)
  }
  return value
}

function connectionFields(body: Record<string, unknown>): ConnectionFields {
  const result: ConnectionFields = {}
  const provider = optionalStringField(body, 'provider', { max: 32, pattern: PROVIDER })
  const baseUrl = optionalStringField(body, 'baseUrl', { max: 500 })
  const model = optionalStringField(body, 'model', { max: 200 })
  const apiKey = optionalApiKey(body)
  if (provider !== undefined) result.provider = provider
  if (baseUrl !== undefined) result.baseUrl = baseUrl
  if (model !== undefined) result.model = model
  if (apiKey !== undefined) result.apiKey = apiKey
  return result
}

function createInput(body: Record<string, unknown>): LlmConfigInput {
  const isDefault = optionalBoolean(body, 'isDefault')
  const isActive = optionalBoolean(body, 'isActive')
  const apiKey = optionalApiKey(body)
  const protocol = optionalLlmProtocol(body.protocol)
  const inputPrice = optionalPrice(body, 'inputPriceMicrosPer1k')
  const outputPrice = optionalPrice(body, 'outputPriceMicrosPer1k')
  return {
    name: stringField(body, 'name', { max: 100 }),
    provider: stringField(body, 'provider', { max: 32, pattern: PROVIDER }),
    ...(protocol === undefined ? {} : { protocol }),
    baseUrl: stringField(body, 'baseUrl', { max: 500 }),
    model: stringField(body, 'model', { max: 200 }),
    purpose: purposeField(body.purpose),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(isDefault === undefined ? {} : { isDefault }),
    ...(isActive === undefined ? {} : { isActive }),
    ...(inputPrice === undefined ? {} : { inputPriceMicrosPer1k: inputPrice }),
    ...(outputPrice === undefined ? {} : { outputPriceMicrosPer1k: outputPrice }),
  }
}

function patchInput(body: Record<string, unknown>): LlmConfigPatch {
  const protocol = optionalLlmProtocol(body.protocol)
  const name = optionalStringField(body, 'name', { max: 100 })
  const isDefault = optionalBoolean(body, 'isDefault')
  const isActive = optionalBoolean(body, 'isActive')
  const inputPrice = optionalPrice(body, 'inputPriceMicrosPer1k')
  const outputPrice = optionalPrice(body, 'outputPriceMicrosPer1k')
  return {
    ...connectionFields(body),
    ...(protocol === undefined ? {} : { protocol }),
    ...(name === undefined ? {} : { name }),
    ...(body.purpose === undefined ? {} : { purpose: purposeField(body.purpose) }),
    ...(isDefault === undefined ? {} : { isDefault }),
    ...(isActive === undefined ? {} : { isActive }),
    ...(inputPrice === undefined ? {} : { inputPriceMicrosPer1k: inputPrice }),
    ...(outputPrice === undefined ? {} : { outputPriceMicrosPer1k: outputPrice }),
  }
}

export function registerModelConfigRoutes(app: FastifyInstance, deps: ModelConfigRouteDeps): void {
  const { models, accounts, config, limiter } = deps
  const guard = async (request: Parameters<typeof requireSession>[0]): Promise<void> => {
    const principal = await requireSession(request, accounts, ['admin'])
    if (!limiter.take(`model-config:${principal.userId}`, config.rateLimitModelConfigPerMinute)) {
      throw tooManyRequests()
    }
  }

  app.get('/v1/admin/model-configs/llm', async request => {
    await guard(request)
    return models.listLlm()
  })

  app.post('/v1/admin/model-configs/llm', async (request, reply) => {
    await guard(request)
    const created = await models.createLlm(createInput(asObject(request.body)))
    return reply.code(201).send(created)
  })

  app.get<{ Params: { configId: string } }>('/v1/admin/model-configs/llm/:configId', async request => {
    await guard(request)
    return models.getLlm(configIdParam(request.params.configId))
  })

  app.patch<{ Params: { configId: string } }>('/v1/admin/model-configs/llm/:configId', async request => {
    await guard(request)
    return models.updateLlm(configIdParam(request.params.configId), patchInput(asObject(request.body)))
  })

  app.delete<{ Params: { configId: string } }>('/v1/admin/model-configs/llm/:configId', async (request, reply) => {
    await guard(request)
    await models.deleteLlm(configIdParam(request.params.configId))
    return reply.code(204).send()
  })

  app.post<{ Params: { configId: string } }>(
    '/v1/admin/model-configs/llm/:configId/set-default',
    async request => {
      await guard(request)
      return models.setDefaultLlm(configIdParam(request.params.configId))
    },
  )

  app.post<{ Params: { configId: string } }>(
    '/v1/admin/model-configs/llm/:configId/test',
    async request => {
      await guard(request)
      return models.testLlm(configIdParam(request.params.configId))
    },
  )

  app.get('/v1/admin/model-configs/asr', async request => {
    await guard(request)
    return models.getAsr()
  })

  app.patch('/v1/admin/model-configs/asr', async request => {
    await guard(request)
    const body = asObject(request.body)
    const enabled = optionalBoolean(body, 'enabled')
    const protocol = body.protocol === undefined ? undefined : protocolField(body.protocol)
    const apiKey = optionalApiKey(body)
    return models.updateAsr({
      ...connectionFields(body),
      ...(protocol === undefined ? {} : { protocol }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(apiKey === undefined ? {} : { apiKey }),
    })
  })

  app.post('/v1/admin/model-configs/asr/test', async request => {
    await guard(request)
    return models.testAsr()
  })
}
