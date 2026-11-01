#!/usr/bin/env node
/**
 * 无依赖压测脚本：固定并发压同一路径，输出 RPS、延迟分位与状态分布。
 * 令牌只从环境变量读取（LOAD_TEST_TOKEN / LOAD_TEST_DEVICE_ID），避免出现在 shell 历史与进程列表。
 * 用法见 docs/operations/monitoring.md。
 */
import { performance } from 'node:perf_hooks'

const USAGE = `用法：node scripts/load-test.mjs [选项]

选项：
  --base-url <url>        目标地址（默认 http://127.0.0.1:3939）
  --path <path>           请求路径（默认 /health）
  --method <method>       GET 或 POST（默认 GET）
  --body <json>           POST 请求体
  --concurrency <n>       并发数（默认 10）
  --duration <sec>        压测时长秒数（默认 10）
  --warmup <sec>          预热秒数，不计入统计（默认 1）
  --timeout-ms <n>        单请求超时（默认 10000）
  --max-p95-ms <n>        P95 阈值，超限退出码 1（默认 500）
  --max-error-rate <r>    错误率阈值，超限退出码 1（默认 0.01）
  --json                  输出 JSON 汇总

环境变量：
  LOAD_TEST_TOKEN         Bearer 令牌（可选）
  LOAD_TEST_DEVICE_ID     x-device-id（可选，带令牌时通常必填）
`

function fail(message) {
  console.error(message)
  console.error(USAGE)
  process.exit(2)
}

function parseArgs(argv) {
  const options = {
    'base-url': process.env.LOAD_TEST_BASE_URL ?? 'http://127.0.0.1:3939',
    path: '/health',
    method: 'GET',
    concurrency: 10,
    duration: 10,
    warmup: 1,
    'timeout-ms': 10_000,
    'max-p95-ms': 500,
    'max-error-rate': 0.01,
    json: false,
  }
  const valueKeys = new Set(['base-url', 'path', 'method', 'body', 'concurrency', 'duration', 'warmup', 'timeout-ms', 'max-p95-ms', 'max-error-rate'])
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    if (raw === '--json') {
      options.json = true
      continue
    }
    if (!raw.startsWith('--')) fail(`未知参数：${raw}`)
    const key = raw.slice(2)
    if (!valueKeys.has(key)) fail(`未知参数：${raw}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`参数缺少值：${raw}`)
    options[key] = value
    index += 1
  }
  for (const key of ['concurrency', 'duration', 'warmup', 'timeout-ms', 'max-p95-ms']) {
    const value = Number(options[key])
    if (!Number.isFinite(value) || value < 0) fail(`参数 ${key} 必须是非负数字`)
    options[key] = value
  }
  const errorRate = Number(options['max-error-rate'])
  if (!Number.isFinite(errorRate) || errorRate < 0 || errorRate > 1) {
    fail('参数 max-error-rate 必须在 0–1 之间')
  }
  options['max-error-rate'] = errorRate
  options.method = String(options.method).toUpperCase()
  if (options.method !== 'GET' && options.method !== 'POST') fail('method 仅支持 GET/POST')
  if (!String(options.path).startsWith('/')) fail('path 必须以 / 开头')
  if (options.concurrency < 1) fail('concurrency 至少为 1')
  if (options.duration <= 0) fail('duration 必须大于 0')
  return options
}

const options = parseArgs(process.argv.slice(2))
const url = new URL(options.path, options['base-url']).toString()

const headers = {}
if (process.env.LOAD_TEST_TOKEN) headers.authorization = `Bearer ${process.env.LOAD_TEST_TOKEN}`
if (process.env.LOAD_TEST_DEVICE_ID) headers['x-device-id'] = process.env.LOAD_TEST_DEVICE_ID
if (options.body !== undefined) headers['content-type'] = 'application/json'

const latencies = []
const statuses = new Map()
let networkErrors = 0

async function once() {
  const started = performance.now()
  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body,
      signal: AbortSignal.timeout(options['timeout-ms']),
    })
    // 必须读完响应体，否则连接复用与真实耗时都不准。
    await response.arrayBuffer()
    latencies.push(performance.now() - started)
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1)
  } catch {
    latencies.push(performance.now() - started)
    networkErrors += 1
  }
}

async function worker(deadline) {
  while (performance.now() < deadline) await once()
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const summary = await (async () => {
  if (options.warmup > 0) await sleep(options.warmup * 1000)
  const deadline = performance.now() + options.duration * 1000
  const started = performance.now()
  await Promise.all(Array.from({ length: options.concurrency }, () => worker(deadline)))
  const elapsed = (performance.now() - started) / 1000

  const sorted = [...latencies].sort((a, b) => a - b)
  const percentile = p => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  const total = sorted.length
  const throttled = statuses.get(429) ?? 0
  const serverErrors = [...statuses].filter(([status]) => status >= 500).reduce((sum, [, count]) => sum + count, 0)
  const clientErrors = [...statuses]
    .filter(([status]) => status >= 400 && status < 500 && status !== 429)
    .reduce((sum, [, count]) => sum + count, 0)
  const errors = networkErrors + serverErrors + clientErrors
  return {
    url,
    method: options.method,
    concurrency: options.concurrency,
    durationSec: Number(elapsed.toFixed(2)),
    requests: total,
    rps: Number((total / elapsed).toFixed(1)),
    p50Ms: Number(percentile(0.5).toFixed(1)),
    p90Ms: Number(percentile(0.9).toFixed(1)),
    p95Ms: Number(percentile(0.95).toFixed(1)),
    p99Ms: Number(percentile(0.99).toFixed(1)),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(1)),
    statuses: Object.fromEntries([...statuses].sort(([a], [b]) => a - b)),
    networkErrors,
    throttled,
    errorRate: total === 0 ? 1 : Number((errors / total).toFixed(4)),
  }
})()

const failures = []
if (summary.requests === 0) failures.push('没有成功的请求')
if (summary.p95Ms > options['max-p95-ms']) {
  failures.push(`P95 ${summary.p95Ms}ms 超过阈值 ${options['max-p95-ms']}ms`)
}
if (summary.errorRate > options['max-error-rate']) {
  failures.push(`错误率 ${(summary.errorRate * 100).toFixed(2)}% 超过阈值 ${(options['max-error-rate'] * 100).toFixed(2)}%`)
}

if (options.json) {
  console.log(JSON.stringify({ ...summary, passed: failures.length === 0, failures }, null, 2))
} else {
  console.log(`目标：${summary.method} ${summary.url}`)
  console.log(`并发 ${summary.concurrency}，时长 ${summary.durationSec}s，请求 ${summary.requests}，RPS ${summary.rps}`)
  console.log(`延迟：P50 ${summary.p50Ms}ms  P90 ${summary.p90Ms}ms  P95 ${summary.p95Ms}ms  P99 ${summary.p99Ms}ms  MAX ${summary.maxMs}ms`)
  console.log(`状态：${JSON.stringify(summary.statuses)}  网络错误 ${summary.networkErrors}  429 ${summary.throttled}`)
  console.log(`错误率：${(summary.errorRate * 100).toFixed(2)}%（网络错误 + 5xx + 非 429 的 4xx）`)
  if (summary.throttled > 0) {
    console.log('提示：出现 429 说明触发了限流；压测账号应单独配置或临时调高 RATE_LIMIT_*。')
  }
  if (failures.length > 0) {
    console.log(`未通过：${failures.join('；')}`)
  } else {
    console.log('通过')
  }
}

process.exit(failures.length === 0 ? 0 : 1)
