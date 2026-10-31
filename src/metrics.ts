import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

export interface Metrics {
  registry: Registry
  httpRequests: Counter<'method' | 'route' | 'status'>
  httpDuration: Histogram<'method' | 'route' | 'status'>
}

/** route 用注册模板而非实际路径，避免把 segmentId 等变量带进标签。 */
export function createMetrics(): Metrics {
  const registry = new Registry()
  collectDefaultMetrics({ register: registry, prefix: 'trend_coach_' })

  const httpRequests = new Counter({
    name: 'trend_coach_http_requests_total',
    help: 'HTTP requests by method, route and status.',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  })
  const httpDuration = new Histogram({
    name: 'trend_coach_http_request_duration_seconds',
    help: 'HTTP request duration by method, route and status.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    registers: [registry],
  })

  return { registry, httpRequests, httpDuration }
}
