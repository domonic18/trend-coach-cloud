import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

export interface Metrics {
  registry: Registry
  httpRequests: Counter<'method' | 'route' | 'status'>
  httpDuration: Histogram<'method' | 'route' | 'status'>
  pipelineJobs: Counter<'kind' | 'status'>
  pipelineStageDuration: Histogram<'kind' | 'stage'>
  pipelineQueueDepth: Gauge
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

  const pipelineJobs = new Counter({
    name: 'trend_coach_pipeline_jobs_total',
    help: 'Pipeline jobs by kind and terminal status.',
    labelNames: ['kind', 'status'],
    registers: [registry],
  })
  const pipelineStageDuration = new Histogram({
    name: 'trend_coach_pipeline_stage_duration_seconds',
    help: 'Pipeline stage duration by kind and stage.',
    labelNames: ['kind', 'stage'],
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
    registers: [registry],
  })
  const pipelineQueueDepth = new Gauge({
    name: 'trend_coach_pipeline_queue_depth',
    help: 'Queued pipeline jobs.',
    registers: [registry],
  })

  return { registry, httpRequests, httpDuration, pipelineJobs, pipelineStageDuration, pipelineQueueDepth }
}
