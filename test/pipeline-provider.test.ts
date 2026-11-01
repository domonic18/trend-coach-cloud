import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { AsrError } from '../src/asr/provider.js'
import { createMiniMaxLongFormAsr } from '../src/asr/longform.js'
import type { AsrConfig, LlmConfig } from '../src/config.js'
import { HttpError } from '../src/errors.js'
import { createEmbeddingProvider } from '../src/kb/embedding.js'
import { LlmError, createLlmClient } from '../src/pipeline/llm.js'
import { makeWav } from './asr-fixtures.js'

interface StubRequest {
  method: string | undefined
  url: string | undefined
  authorization: string | undefined
  apiKey: string | undefined
  anthropicVersion: string | undefined
  contentType: string | undefined
  body: Buffer
}

interface StubServer {
  url: string
  requests: StubRequest[]
  close(): Promise<void>
}

async function startStub(
  handler: (request: IncomingMessage, body: Buffer, response: ServerResponse) => void,
): Promise<StubServer> {
  const requests: StubRequest[] = []
  const server = createServer(async (request, response) => {
    response.on('error', () => {})
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined,
      anthropicVersion: typeof request.headers['anthropic-version'] === 'string'
        ? request.headers['anthropic-version']
        : undefined,
      contentType: request.headers['content-type'],
      body,
    })
    handler(request, body, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function jsonResponse(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

function asrConfig(baseUrl: string): AsrConfig {
  return { protocol: 'minimax', baseUrl, apiKey: 'test-asr-key', model: 'asr-1.0', timeoutMs: 1000 }
}

function llmConfig(baseUrl: string, overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    protocol: 'openai',
    baseUrl,
    model: 'm1-model',
    apiKey: 'test-llm-key',
    timeoutMs: 1000,
    temperature: 0.2,
    maxTokens: 256,
    maxInputChars: 200,
    ...overrides,
  }
}

let dir = ''
let wavPath = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trend-coach-asr-'))
  wavPath = join(dir, 'chunk.wav')
  await writeFile(wavPath, makeWav({ durationMs: 3000 }))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('长音频转写发送句级时间戳参数并解析结果', async () => {
  const stub = await startStub((_request, _body, response) => {
    jsonResponse(response, {
      text: '整段',
      sentences: [
        { start_ms: 100, end_ms: 900, text: '第一句' },
        { start_ms: 900, end_ms: 2000, text: '第二句' },
      ],
    })
  })
  try {
    const asr = createMiniMaxLongFormAsr(asrConfig(stub.url))
    const sentences = await asr.transcribe({
      wavPath,
      durationMs: 3000,
      language: 'zh',
      timeoutMs: 2000,
      signal: new AbortController().signal,
    })
    assert.deepEqual(sentences, [
      { startMs: 100, endMs: 900, text: '第一句' },
      { startMs: 900, endMs: 2000, text: '第二句' },
    ])

    const request = stub.requests[0]
    assert.equal(request?.url, '/v1/speech_to_text')
    assert.equal(request?.authorization, 'Bearer test-asr-key')
    assert.match(request?.contentType ?? '', /multipart\/form-data/)
    const body = request?.body.toString('utf8') ?? ''
    assert.match(body, /name="model"/)
    assert.match(body, /asr-1\.0/)
    assert.match(body, /name="response_format"/)
    assert.match(body, /verbose_json/)
    assert.match(body, /name="timestamp_level"/)
    assert.match(body, /name="language"/)
    assert.match(body, /zh/)
  } finally {
    await stub.close()
  }
})

test('长音频转写：无时间戳退化为整块一句话', async () => {
  const stub = await startStub((_request, _body, response) => {
    jsonResponse(response, { text: '整段文本' })
  })
  try {
    const asr = createMiniMaxLongFormAsr(asrConfig(stub.url))
    assert.deepEqual(
      await asr.transcribe({
        wavPath,
        durationMs: 2500,
        language: 'auto',
        timeoutMs: 2000,
        signal: new AbortController().signal,
      }),
      [{ startMs: 0, endMs: 2500, text: '整段文本' }],
    )
  } finally {
    await stub.close()
  }
})

test('长音频转写错误映射', async () => {
  const cases: { status: number; payload: unknown; kind: 'rate_limited' | 'unavailable' | 'invalid_response' }[] = [
    { status: 429, payload: {}, kind: 'rate_limited' },
    { status: 503, payload: {}, kind: 'unavailable' },
    { status: 400, payload: {}, kind: 'invalid_response' },
    { status: 200, payload: { base_resp: { status_code: 1004 } }, kind: 'invalid_response' },
    { status: 200, payload: { text: '' }, kind: 'invalid_response' },
  ]
  for (const item of cases) {
    const stub = await startStub((_request, _body, response) => {
      jsonResponse(response, item.payload, item.status)
    })
    try {
      const asr = createMiniMaxLongFormAsr(asrConfig(stub.url))
      await assert.rejects(
        asr.transcribe({
          wavPath,
          durationMs: 3000,
          language: 'auto',
          timeoutMs: 2000,
          signal: new AbortController().signal,
        }),
        (error: unknown) => error instanceof AsrError && error.kind === item.kind,
      )
    } finally {
      await stub.close()
    }
  }
})

test('LLM 请求体符合 OpenAI 兼容约定并解析 JSON', async () => {
  const stub = await startStub((_request, _body, response) => {
    jsonResponse(response, {
      choices: [{ finish_reason: 'stop', message: { content: '```json\n{"ok":true,"items":[1,2]}\n```' } }],
    })
  })
  try {
    const llm = createLlmClient(llmConfig(`${stub.url}/v1`))
    const parsed = await llm.completeJson(
      { system: 'system', user: 'user' },
      value => {
        if (typeof value !== 'object' || value === null) throw new Error('invalid')
        return value as { ok: boolean; items: number[] }
      },
    )
    assert.deepEqual(parsed, { ok: true, items: [1, 2] })

    const request = stub.requests[0]
    assert.equal(request?.url, '/v1/chat/completions')
    assert.equal(request?.authorization, 'Bearer test-llm-key')
    const body = JSON.parse(request?.body.toString('utf8') ?? '{}') as Record<string, unknown>
    assert.equal(body.model, 'm1-model')
    assert.equal(body.temperature, 0.2)
    assert.equal(body.max_tokens, 256)
    assert.deepEqual(body.response_format, { type: 'json_object' })
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ])
  } finally {
    await stub.close()
  }
})

test('LLM Anthropic Messages 请求与响应解析', async () => {
  const stub = await startStub((_request, _body, response) => {
    jsonResponse(response, {
      content: [
        { type: 'text', text: '```json\n{"ok":true,' },
        { type: 'text', text: '"items":[1,2]}\n```' },
      ],
      stop_reason: 'end_turn',
    })
  })
  try {
    const llm = createLlmClient(llmConfig(stub.url, {
      protocol: 'anthropic',
      baseUrl: stub.url,
      apiKey: 'test-anthropic-key',
    }))
    const parsed = await llm.completeJson(
      { system: 'system', user: 'user' },
      value => value as { ok: boolean; items: number[] },
    )
    assert.deepEqual(parsed, { ok: true, items: [1, 2] })

    const request = stub.requests[0]
    assert.equal(request?.url, '/v1/messages')
    assert.equal(request?.authorization, 'Bearer test-anthropic-key')
    assert.equal(request?.apiKey, 'test-anthropic-key')
    assert.equal(request?.anthropicVersion, '2023-06-01')
    const body = JSON.parse(request?.body.toString('utf8') ?? '{}') as Record<string, unknown>
    assert.equal(body.model, 'm1-model')
    assert.equal(body.max_tokens, 256)
    assert.equal(body.system, 'system')
    assert.equal(body.response_format, undefined)
    assert.deepEqual(body.messages, [{ role: 'user', content: 'user' }])
  } finally {
    await stub.close()
  }
})

test('LLM Anthropic 截断与空内容映射为错误', async () => {
  for (const item of [
    { payload: { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'max_tokens' }, kind: 'truncated' },
    { payload: { content: [], stop_reason: 'end_turn' }, kind: 'invalid_response' },
  ]) {
    const stub = await startStub((_request, _body, response) => jsonResponse(response, item.payload))
    try {
      const llm = createLlmClient(llmConfig(stub.url, { protocol: 'anthropic', baseUrl: stub.url }))
      await assert.rejects(
        llm.completeJson({ system: 's', user: 'u' }, value => value),
        (error: unknown) => error instanceof LlmError && error.kind === item.kind,
      )
    } finally {
      await stub.close()
    }
  }
})

test('LLM 错误映射与输入上限', async () => {
  const cases: { status: number; content: string | null; finish: string; kind: string }[] = [
    { status: 429, content: null, finish: 'stop', kind: 'rate_limited' },
    { status: 500, content: null, finish: 'stop', kind: 'unavailable' },
    { status: 400, content: null, finish: 'stop', kind: 'invalid_response' },
    { status: 200, content: 'not json', finish: 'stop', kind: 'invalid_response' },
    { status: 200, content: '{"ok":true}', finish: 'length', kind: 'truncated' },
  ]
  for (const item of cases) {
    const stub = await startStub((_request, _body, response) => {
      jsonResponse(response, {
        choices: [{ finish_reason: item.finish, message: { content: item.content ?? '' } }],
      }, item.status)
    })
    try {
      const llm = createLlmClient(llmConfig(stub.url))
      await assert.rejects(
        llm.completeJson({ system: 's', user: 'u' }, value => value),
        (error: unknown) => error instanceof LlmError && error.kind === item.kind,
      )
    } finally {
      await stub.close()
    }
  }

  const stub = await startStub((_request, _body, response) => jsonResponse(response, {}))
  try {
    const llm = createLlmClient(llmConfig(stub.url))
    await assert.rejects(
      llm.completeJson({ system: 'x'.repeat(150), user: 'y'.repeat(60) }, value => value),
      (error: unknown) => error instanceof LlmError && error.kind === 'input_too_large',
    )
    assert.equal(stub.requests.length, 0)
  } finally {
    await stub.close()
  }
})

test('embedding 请求显式声明 1024 维并解析向量', async () => {
  const stub = await startStub((_request, _body, response) => {
    jsonResponse(response, { data: [{ embedding: Array.from({ length: 1024 }, () => 0.5) }] })
  })
  try {
    const embed = createEmbeddingProvider({ baseUrl: stub.url, model: 'embedding-3', apiKey: 'embed-key' })
    const vector = await embed('趋势交易')
    assert.equal(vector.length, 1024)

    const request = stub.requests[0]
    assert.equal(request?.url, '/embeddings')
    assert.equal(request?.authorization, 'Bearer embed-key')
    const body = JSON.parse(request?.body.toString('utf8') ?? '{}') as Record<string, unknown>
    assert.equal(body.model, 'embedding-3')
    assert.equal(body.dimensions, 1024)
  } finally {
    await stub.close()
  }
})

test('embedding 模型不支持 dimensions 时回退一次', async () => {
  const stub = await startStub((_request, body, response) => {
    const parsed = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>
    if (parsed.dimensions !== undefined) {
      jsonResponse(response, { error: { message: 'Unrecognized request argument: dimensions' } }, 400)
      return
    }
    jsonResponse(response, { data: [{ embedding: Array.from({ length: 1024 }, () => 0.25) }] })
  })
  try {
    const embed = createEmbeddingProvider({ baseUrl: stub.url, model: 'text-embedding-ada-002' })
    const vector = await embed('趋势交易')
    assert.equal(vector.length, 1024)
    assert.equal(stub.requests.length, 2)
    const first = JSON.parse(stub.requests[0]?.body.toString('utf8') ?? '{}') as Record<string, unknown>
    const second = JSON.parse(stub.requests[1]?.body.toString('utf8') ?? '{}') as Record<string, unknown>
    assert.equal(first.dimensions, 1024)
    assert.equal(second.dimensions, undefined)
  } finally {
    await stub.close()
  }
})

test('embedding 维度不符或上游失败映射为 503', async () => {
  const short = await startStub((_request, _body, response) => {
    jsonResponse(response, { data: [{ embedding: [0.1, 0.2] }] })
  })
  try {
    const embed = createEmbeddingProvider({ baseUrl: short.url, model: 'm' })
    await assert.rejects(embed('x'), (error: unknown) => error instanceof HttpError && error.statusCode === 503)
  } finally {
    await short.close()
  }

  const down = await startStub((_request, _body, response) => {
    jsonResponse(response, { error: 'rate limited' }, 429)
  })
  try {
    const embed = createEmbeddingProvider({ baseUrl: down.url, model: 'm' })
    await assert.rejects(embed('x'), (error: unknown) => error instanceof HttpError && error.statusCode === 503)
  } finally {
    await down.close()
  }
})
