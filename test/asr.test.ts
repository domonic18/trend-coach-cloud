import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test from 'node:test'
import { parseAsrBody } from '../src/asr/audio.js'
import { AsrError, createMiniMaxProvider, normalizeAsrBaseUrl } from '../src/asr/provider.js'
import { cleanTranscript } from '../src/asr/routes.js'
import type { AsrConfig } from '../src/config.js'
import { makeWav, wavBase64 } from './asr-fixtures.js'

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

function asrConfig(baseUrl: string, timeoutMs = 1000): AsrConfig {
  return { baseUrl, apiKey: 'test-asr-key', model: 'asr-1.0', timeoutMs }
}

function jsonResponse(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

test('parseAsrBody 接受 16kHz 单声道 PCM16 wav', () => {
  const audio = wavBase64({ durationMs: 12_000 })
  const parsed = parseAsrBody({ audio, format: 'wav', durationMs: 12_000 })
  assert.equal(parsed.durationMs, 12_000)
  assert.equal(parsed.bytes.length, makeWav({ durationMs: 12_000 }).length)
})

test('parseAsrBody 拒绝未通过 WAV 规格校验的音频', () => {
  const valid = makeWav({ durationMs: 5000 })
  const cases: { name: string; body: unknown; pattern: RegExp }[] = [
    { name: '非对象', body: [], pattern: /JSON object/ },
    { name: '格式错误', body: { audio: wavBase64(), format: 'webm', durationMs: 1000 }, pattern: /format must be wav/ },
    { name: '时长缺失', body: { audio: wavBase64(), format: 'wav' }, pattern: /durationMs/ },
    { name: '时长越界', body: { audio: wavBase64(), format: 'wav', durationMs: 60_001 }, pattern: /durationMs/ },
    { name: '时长为小数', body: { audio: wavBase64(), format: 'wav', durationMs: 1.5 }, pattern: /durationMs/ },
    { name: '时长为字符串', body: { audio: wavBase64(), format: 'wav', durationMs: '1000' }, pattern: /durationMs/ },
    { name: '音频缺失', body: { format: 'wav', durationMs: 1000 }, pattern: /non-empty string/ },
    { name: '音频非字符串', body: { audio: 42, format: 'wav', durationMs: 1000 }, pattern: /non-empty string/ },
    { name: '非法 base64', body: { audio: 'not base64!!', format: 'wav', durationMs: 1000 }, pattern: /valid base64/ },
    { name: '长度不对齐', body: { audio: 'AAAAA', format: 'wav', durationMs: 1000 }, pattern: /valid base64/ },
    { name: '过短', body: { audio: Buffer.alloc(20).toString('base64'), format: 'wav', durationMs: 1000 }, pattern: /not a wav/ },
    { name: '错误 magic', body: { audio: Buffer.concat([Buffer.from('RIFX'), valid.subarray(4)]).toString('base64'), format: 'wav', durationMs: 5000 }, pattern: /not a wav/ },
    { name: '立体声', body: { audio: wavBase64({ channels: 2 }), format: 'wav', durationMs: 1000 }, pattern: /16kHz mono PCM16/ },
    { name: '44.1kHz', body: { audio: wavBase64({ sampleRate: 44_100 }), format: 'wav', durationMs: 1000 }, pattern: /16kHz mono PCM16/ },
    { name: '8bit', body: { audio: wavBase64({ bits: 8 }), format: 'wav', durationMs: 1000 }, pattern: /16kHz mono PCM16/ },
    { name: '浮点 PCM', body: { audio: wavBase64({ audioFormat: 3 }), format: 'wav', durationMs: 1000 }, pattern: /16kHz mono PCM16/ },
    { name: '时长不符', body: { audio: wavBase64({ durationMs: 10_000 }), format: 'wav', durationMs: 13_000 }, pattern: /duration mismatch/ },
    { name: '超出容量', body: { audio: wavBase64({ durationMs: 61_500 }), format: 'wav', durationMs: 60_000 }, pattern: /valid base64/ },
    { name: 'data 被截断', body: { audio: valid.subarray(0, valid.length - 10).toString('base64'), format: 'wav', durationMs: 5000 }, pattern: /out of bounds/ },
  ]
  for (const item of cases) {
    assert.throws(() => parseAsrBody(item.body), item.pattern, item.name)
  }
})

test('parseAsrBody 允许 ±1s 的时长误差', () => {
  const audio = wavBase64({ durationMs: 5000 })
  assert.equal(parseAsrBody({ audio, format: 'wav', durationMs: 6000 }).durationMs, 6000)
  assert.equal(parseAsrBody({ audio, format: 'wav', durationMs: 4000 }).durationMs, 4000)
})

test('cleanTranscript 剥离控制字符并折叠空白', () => {
  const noisy = String.fromCharCode(0, 7) + ' 你好\n\n世界\t '
  assert.equal(cleanTranscript(noisy), '你好 世界')
  assert.equal(cleanTranscript(String.fromCharCode(0x7f)), '')
})

test('normalizeAsrBaseUrl 归一化完整端点与版本后缀', () => {
  assert.equal(normalizeAsrBaseUrl('https://api.minimaxi.com'), 'https://api.minimaxi.com')
  assert.equal(normalizeAsrBaseUrl('https://api.minimaxi.com/'), 'https://api.minimaxi.com')
  assert.equal(normalizeAsrBaseUrl('https://api.minimaxi.com/v1'), 'https://api.minimaxi.com')
  assert.equal(normalizeAsrBaseUrl('https://api.minimaxi.com/v1/speech_to_text'), 'https://api.minimaxi.com')
  assert.equal(normalizeAsrBaseUrl('https://api.minimaxi.com/speech_to_text/'), 'https://api.minimaxi.com')
  assert.equal(normalizeAsrBaseUrl(' https://proxy.example.com/asr/v1 '), 'https://proxy.example.com/asr')
})

test('MiniMax provider 发送 multipart wav 并解析 text', async () => {
  const stub = await startStub((_request, _body, response) => jsonResponse(response, { text: '均线系统如何设置？' }))
  try {
    const provider = createMiniMaxProvider(asrConfig(stub.url))
    const result = await provider.transcribe(makeWav({ durationMs: 1000 }), 1000)
    assert.equal(result, '均线系统如何设置？')

    const request = stub.requests[0]
    assert.ok(request !== undefined)
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/speech_to_text')
    assert.equal(request.authorization, 'Bearer test-asr-key')
    assert.match(request.contentType ?? '', /^multipart\/form-data/)
    const body = request.body.toString('latin1')
    assert.match(body, /name="file"; filename="voice.wav"/)
    assert.match(body, /Content-Type: audio\/wav/)
    assert.match(body, /name="model"/)
    assert.match(body, /asr-1\.0/)
    assert.match(body, /name="response_format"/)
    assert.match(body, /json/)
    assert.ok(request.body.includes(Buffer.from('RIFF')))
  } finally {
    await stub.close()
  }
})

test('MiniMax provider 把业务错误码与 HTTP 状态映射为受控错误', async () => {
  const cases: { name: string; kind: AsrError['kind']; respond: (response: ServerResponse) => void }[] = [
    {
      name: 'base_resp 业务错误',
      kind: 'invalid_response',
      respond: response => jsonResponse(response, { base_resp: { status_code: 1004, status_msg: 'invalid api key' } }),
    },
    { name: '429', kind: 'rate_limited', respond: response => jsonResponse(response, {}, 429) },
    { name: '500', kind: 'unavailable', respond: response => jsonResponse(response, {}, 500) },
    {
      name: '400',
      kind: 'invalid_response',
      respond: response => jsonResponse(response, { error: 'bad request' }, 400),
    },
    { name: '非 JSON', kind: 'invalid_response', respond: response => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('oops') } },
    { name: '缺少 text', kind: 'invalid_response', respond: response => jsonResponse(response, { text: 42 }) },
    { name: '非对象响应', kind: 'invalid_response', respond: response => jsonResponse(response, []) },
  ]

  for (const item of cases) {
    const stub = await startStub((_request, _body, response) => item.respond(response))
    try {
      const provider = createMiniMaxProvider(asrConfig(stub.url))
      await assert.rejects(provider.transcribe(makeWav(), 1000), (error: unknown) => {
        assert.ok(error instanceof AsrError, item.name)
        assert.equal(error.kind, item.kind, item.name)
        return true
      }, item.name)
    } finally {
      await stub.close()
    }
  }
})

test('MiniMax provider 在超时或连接失败时报 unavailable', async () => {
  const stub = await startStub((_request, _body, response) => {
    setTimeout(() => {
      try {
        jsonResponse(response, { text: '迟到的结果' })
      } catch {
        // 客户端已超时断开，忽略写回。
      }
    }, 500)
  })
  try {
    const provider = createMiniMaxProvider(asrConfig(stub.url, 50))
    await assert.rejects(provider.transcribe(makeWav(), 1000), (error: unknown) => {
      assert.ok(error instanceof AsrError)
      assert.equal(error.kind, 'unavailable')
      return true
    })
  } finally {
    await stub.close()
  }

  const closed = await startStub((_request, _body, response) => jsonResponse(response, { text: 'unreachable' }))
  const url = closed.url
  await closed.close()
  const provider = createMiniMaxProvider(asrConfig(url))
  await assert.rejects(provider.transcribe(makeWav(), 1000), (error: unknown) => {
    assert.ok(error instanceof AsrError)
    assert.equal(error.kind, 'unavailable')
    return true
  })
})
