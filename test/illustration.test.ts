import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { CodedHttpError } from '../src/errors.js'
import {
  createArkImageClient,
  ImageProviderError,
  MAX_IMAGE_BYTES,
} from '../src/illustration/ark.js'
import {
  budgetState,
  canSpend,
  imageBudgetError,
  type ImageBudget,
} from '../src/illustration/budget.js'
import { parseImageSize } from '../src/illustration/image-size.js'
import { signFigureUrl, verifyFigureSignature } from '../src/media/figure-sign.js'
import type { ResolvedImage } from '../src/model-config/service.js'

const SECRET = 'illustration-test-signing-secret'
const BASE = 'http://127.0.0.1:3939/media'

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function jpeg(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(16)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  bytes[2] = 0xff
  bytes[3] = 0xc0
  bytes.writeUInt16BE(11, 4)
  bytes[6] = 0x08
  bytes.writeUInt16BE(height, 7)
  bytes.writeUInt16BE(width, 9)
  return bytes
}

function budget(mutate: Partial<ImageBudget> = {}): ImageBudget {
  return {
    courseSpentMicros: 0,
    courseLimitMicros: 10_000_000,
    orgSpentMicros: 0,
    orgLimitMicros: 300_000_000,
    ...mutate,
  }
}

test('图示尺寸：只读 PNG/JPEG 头部，未知格式判失败', () => {
  assert.deepEqual(parseImageSize(png(1024, 768)), { format: 'png', width: 1024, height: 768 })
  assert.deepEqual(parseImageSize(jpeg(1280, 720)), { format: 'jpeg', width: 1280, height: 720 })
  assert.equal(parseImageSize(Buffer.from('not-an-image')), undefined)
  assert.equal(parseImageSize(Buffer.alloc(0)), undefined)
  assert.equal(parseImageSize(Buffer.concat([png(0, 100)])), undefined)
})

test('图片预算：可花判定、80% 预警与耗尽状态', () => {
  assert.equal(canSpend(budget(), 2_500_000), true)
  assert.equal(canSpend(budget({ courseSpentMicros: 7_500_000 }), 2_500_000), true)
  assert.equal(canSpend(budget({ courseSpentMicros: 8_000_000 }), 2_500_000), false)
  assert.equal(canSpend(budget({ orgSpentMicros: 299_000_000 }), 2_500_000), false)

  const safe = budgetState(budget({ courseSpentMicros: 7_999_999 }))
  assert.equal(safe.warning, false)
  assert.equal(safe.exhausted, false)
  const warned = budgetState(budget({ courseSpentMicros: 8_000_000 }))
  assert.equal(warned.warning, true)
  assert.equal(warned.exhausted, false)
  const spent = budgetState(budget({ courseSpentMicros: 10_000_000 }))
  assert.equal(spent.exhausted, true)
})

test('图片预算：超限抛带明细的 409 编码错误', () => {
  assert.throws(
    () => imageBudgetError(budget({ courseSpentMicros: 9_000_000 })),
    (error: unknown) => {
      assert.ok(error instanceof CodedHttpError)
      assert.equal(error.statusCode, 409)
      assert.equal(error.code, 'image_budget_exceeded')
      assert.equal(error.details.courseSpentMicros, 9_000_000)
      assert.equal(error.details.courseLimitMicros, 10_000_000)
      return true
    },
  )
})

test('图示签名：路径绑定、过期与篡改均失效', () => {
  const relPath = 'fig_0123456789ab/cand_0123456789abcdef.png'
  const now = 1_760_000_000_000
  const url = signFigureUrl(SECRET, BASE, relPath, 600, now)
  assert.match(url, /^http:\/\/127\.0\.0\.1:3939\/media\/figures\/fig_0123456789ab\/cand_0123456789abcdef\.png\?expires=\d+&sig=/)
  const parsed = new URL(url)
  const expires = parsed.searchParams.get('expires')
  const sig = parsed.searchParams.get('sig')
  assert.equal(verifyFigureSignature(SECRET, relPath, expires, sig, Math.floor(now / 1000)), true)
  assert.equal(verifyFigureSignature(SECRET, relPath, expires, sig, Math.floor(now / 1000) + 601), false)
  assert.equal(verifyFigureSignature(SECRET, relPath, expires, 'bad-signature', Math.floor(now / 1000)), false)
  assert.equal(verifyFigureSignature(SECRET, 'fig_0123456789ab/cand_other.png', expires, sig, Math.floor(now / 1000)), false)
  assert.equal(verifyFigureSignature(SECRET, relPath, 'abc', sig, Math.floor(now / 1000)), false)
  assert.throws(() => signFigureUrl(SECRET, BASE, '../../etc/passwd', 600, now), /invalid figure path/)
})

let server: Server
let baseUrl = ''
let mode: 'ok' | 'rate_limited' | 'server_error' | 'bad_payload' | 'not_found_image' = 'ok'
let lastRequest: { authorization?: string; body?: Record<string, unknown> } = {}

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      if (request.url === '/images/generations') {
        lastRequest = {
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as Record<string, unknown>,
        }
        if (mode === 'rate_limited') {
          response.writeHead(429, { 'content-type': 'application/json' })
          response.end('{"error":{"message":"rate limited"}}')
          return
        }
        if (mode === 'server_error') {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end('{"error":{"message":"boom"}}')
          return
        }
        if (mode === 'bad_payload') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"data":[]}')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          data: [{ url: `${baseUrl}/img-${mode}.png` }],
        }))
        return
      }
      if (request.url?.startsWith('/img-')) {
        if (mode === 'not_found_image') {
          response.writeHead(404)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'image/png' })
        response.end(png(512, 512))
        return
      }
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const resolved: ResolvedImage = {
  configId: 'llmc_0123456789abcdef',
  provider: 'ark',
  baseUrl: '',
  model: 'doubao-seedream-test',
  apiKey: 'ark-test-key',
  priceMicros: 120_000,
}

test('Ark 客户端：请求体、鉴权与图片下载', async () => {
  mode = 'ok'
  const client = createArkImageClient({ ...resolved, baseUrl }, 5_000)
  const image = await client.generate('趋势反转结构示意图')
  assert.equal(image.format, 'png')
  assert.deepEqual(image.bytes, png(512, 512))
  assert.equal(lastRequest.authorization, 'Bearer ark-test-key')
  assert.equal(lastRequest.body?.model, 'doubao-seedream-test')
  assert.equal(lastRequest.body?.prompt, '趋势反转结构示意图')
  assert.equal(lastRequest.body?.size, '2K')
  assert.equal(lastRequest.body?.response_format, 'url')
  assert.equal(lastRequest.body?.watermark, false)
})

test('Ark 客户端：429 标记限流，服务错误与坏响应标记失败', async () => {
  const client = createArkImageClient({ ...resolved, baseUrl }, 5_000)
  mode = 'rate_limited'
  await assert.rejects(() => client.generate('x'), (error: unknown) => {
    assert.ok(error instanceof ImageProviderError)
    assert.equal(error.kind, 'rate_limited')
    return true
  })
  mode = 'server_error'
  await assert.rejects(() => client.generate('x'), (error: unknown) => {
    assert.ok(error instanceof ImageProviderError)
    assert.equal(error.kind, 'unavailable')
    return true
  })
  mode = 'bad_payload'
  await assert.rejects(() => client.generate('x'), (error: unknown) => {
    assert.ok(error instanceof ImageProviderError)
    assert.equal(error.kind, 'invalid')
    return true
  })
  mode = 'not_found_image'
  await assert.rejects(() => client.generate('x'), (error: unknown) => {
    assert.ok(error instanceof ImageProviderError)
    assert.equal(error.kind, 'unavailable')
    return true
  })
  mode = 'ok'
})

test('Ark 客户端：外部取消立即失败且不重试', async () => {
  const client = createArkImageClient({ ...resolved, baseUrl }, 5_000)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => client.generate('x', { signal: controller.signal }),
    (error: unknown) => error instanceof ImageProviderError,
  )
  assert.ok(MAX_IMAGE_BYTES >= 8 * 1024 * 1024)
})
