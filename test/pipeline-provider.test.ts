import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { AsrError } from '../src/asr/provider.js'
import { createMiniMaxLongFormAsr } from '../src/asr/longform.js'
import type { AsrConfig, LlmConfig } from '../src/config.js'
import { LlmError, createLlmClient } from '../src/pipeline/llm.js'
import { makeWav } from './asr-fixtures.js'

interface StubRequest {
  method: string | undefined
  url: string | undefined
  authorization: string | undefined
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
  return { baseUrl, apiKey: 'test-asr-key', model: 'asr-1.0', timeoutMs: 1000 }
}

function llmConfig(baseUrl: string, overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
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
