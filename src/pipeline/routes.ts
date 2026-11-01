import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AccountService } from '../accounts/service.js'
import type { AppConfig } from '../config.js'
import { parseContentId, titleField } from '../content/service.js'
import { badRequest, HttpError, notFound, tooManyRequests } from '../errors.js'
import { requireSession } from '../http/principal.js'
import { asObject, optionalStringField } from '../http/validation.js'
import { RateLimiter } from '../rate-limit.js'
import {
  parseAssetId,
  parseAssetStatus,
  parseCandidateId,
  parseFigureId,
  parseGenerationId,
  parseJobId,
  parseJobKind,
  parseJobStatus,
  parseLanguage,
  parseSha256Header,
  type PipelineApi,
} from './service.js'

export interface PipelineRouteDeps {
  api: PipelineApi
  accounts: AccountService
  config: AppConfig
  limiter: RateLimiter
}

function queryInt(
  query: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = query[key]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

function queryText(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export async function registerPipelineRoutes(app: FastifyInstance, deps: PipelineRouteDeps): Promise<void> {
  const { api, accounts, config, limiter } = deps
  const uploadLimit = config.pipeline?.maxUploadBytes ?? 1024 * 1024
  const staff = (request: FastifyRequest): Promise<{ userId: string }> =>
    requireSession(request, accounts, ['operator', 'admin'])

  const guard = async (request: FastifyRequest): Promise<void> => {
    const principal = await staff(request)
    if (!limiter.take(`pipeline:${principal.userId}`, config.rateLimitPipelinePerMinute)) {
      throw tooManyRequests()
    }
  }

  app.get('/v1/admin/content/media-assets', async request => {
    await guard(request)
    const query = asObject(request.query)
    return api.listAssets({
      ...(query.courseId === undefined
        ? {}
        : { courseId: parseContentId(String(query.courseId), 'courseId') }),
      ...(query.status === undefined ? {} : { status: parseAssetStatus(query.status) }),
      offset: queryInt(query, 'offset', 0, 0, 100_000),
      limit: queryInt(query, 'limit', 50, 1, 100),
    })
  })

  app.post('/v1/admin/content/media-assets', async (request, reply) => {
    await guard(request)
    const body = asObject(request.body)
    const asset = await api.createAsset({
      courseId: parseContentId(String(body.courseId ?? ''), 'courseId'),
      title: titleField(body),
    })
    return reply.code(201).send({ asset })
  })

  app.patch('/v1/admin/content/media-assets/:assetId', async request => {
    await guard(request)
    const { assetId } = request.params as { assetId: string }
    const body = asObject(request.body)
    const title = optionalStringField(body, 'title', { min: 1, max: 200 })
    let status: 'archived' | undefined
    if (body.status !== undefined) {
      if (body.status !== 'archived') throw badRequest('status must be archived')
      status = 'archived'
    }
    if (title === undefined && status === undefined) {
      throw badRequest('at least one of title, status is required')
    }
    return {
      asset: await api.patchAsset(parseAssetId(assetId), {
        ...(title === undefined ? {} : { title }),
        ...(status === undefined ? {} : { status }),
      }),
    }
  })

  // 上传解析器只在本插件作用域注册，避免影响其它 JSON 接口。
  await app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
      done(null, payload)
    })

    scope.put('/v1/admin/content/media-assets/:assetId/source', {
      bodyLimit: uploadLimit,
      preParsing: async (request, _reply, payload) => {
        await guard(request)
        const raw = request.headers['content-length']
        const declared = raw === undefined ? Number.NaN : Number(raw)
        if (Number.isFinite(declared) && declared > uploadLimit) {
          throw new HttpError(413, 'payload too large')
        }
        return payload
      },
    }, async request => {
      const { assetId } = request.params as { assetId: string }
      const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
      if (contentType !== 'application/octet-stream') {
        throw new HttpError(415, 'unsupported media type')
      }
      const body = request.body as AsyncIterable<Buffer> | undefined
      if (body === undefined || typeof body !== 'object') throw badRequest('source body required')
      const header = request.headers['x-file-sha256']
      const expectedSha256 = parseSha256Header(Array.isArray(header) ? header[0] : header)
      const id = parseAssetId(assetId)
      const asset = expectedSha256 === undefined
        ? await api.uploadSource(id, body)
        : await api.uploadSource(id, body, expectedSha256)
      return { asset }
    })
  })

  app.post('/v1/admin/content/media-assets/:assetId/generations', async (request, reply) => {
    await guard(request)
    const { assetId } = request.params as { assetId: string }
    const job = await api.enqueueGeneration(parseAssetId(assetId))
    return reply.code(202).send({ job })
  })

  app.get('/v1/admin/content/generations/:generationId', async request => {
    await guard(request)
    const { generationId } = request.params as { generationId: string }
    return api.getGeneration(parseGenerationId(generationId))
  })

  app.post('/v1/admin/content/generations/:generationId/apply', async request => {
    await guard(request)
    const { generationId } = request.params as { generationId: string }
    return api.applyGeneration(parseGenerationId(generationId))
  })

  app.post('/v1/admin/content/generations/:generationId/discard', async request => {
    await guard(request)
    const { generationId } = request.params as { generationId: string }
    return api.discardGeneration(parseGenerationId(generationId))
  })

  app.post('/v1/admin/content/courses/:courseId/illustrate', async (request, reply) => {
    await guard(request)
    const { courseId } = request.params as { courseId: string }
    const body = request.body === undefined ? {} : asObject(request.body)
    let chapterIds: string[] | undefined
    if (body.chapterIds !== undefined) {
      if (!Array.isArray(body.chapterIds)) throw badRequest('chapterIds must be an array')
      chapterIds = body.chapterIds.map(id => parseContentId(String(id), 'chapterId'))
    }
    const job = await api.enqueueIllustrate(parseContentId(courseId, 'courseId'), chapterIds)
    return reply.code(202).send({ job })
  })

  app.get('/v1/admin/content/figures', async request => {
    await guard(request)
    const query = asObject(request.query)
    const courseId = queryText(query, 'courseId')
    const chapterId = queryText(query, 'chapterId')
    return api.listFigures({
      ...(courseId === undefined ? {} : { courseId: parseContentId(courseId, 'courseId') }),
      ...(chapterId === undefined ? {} : { chapterId: parseContentId(chapterId, 'chapterId') }),
      offset: queryInt(query, 'offset', 0, 0, 100_000),
      limit: queryInt(query, 'limit', 50, 1, 100),
    })
  })

  app.post('/v1/admin/content/figures/:figureId/select', async request => {
    await guard(request)
    const { figureId } = request.params as { figureId: string }
    const body = asObject(request.body)
    return {
      figure: await api.selectFigure(
        parseFigureId(figureId),
        parseCandidateId(String(body.candidateId ?? '')),
      ),
    }
  })

  app.post('/v1/admin/content/figures/:figureId/regenerate', async (request, reply) => {
    await guard(request)
    const { figureId } = request.params as { figureId: string }
    const figure = await api.regenerateFigure(parseFigureId(figureId))
    return reply.code(202).send({ figure })
  })

  app.delete('/v1/admin/content/figures/:figureId', async (request, reply) => {
    await guard(request)
    const { figureId } = request.params as { figureId: string }
    await api.deleteFigure(parseFigureId(figureId))
    return reply.code(204).send()
  })

  app.get('/v1/admin/content/figure-candidates/:candidateId', async (request, reply) => {
    await guard(request)
    const { candidateId } = request.params as { candidateId: string }
    const { relPath } = await api.candidateFile(parseCandidateId(candidateId))
    const root = config.figureLocalDir
    if (root === undefined) throw new HttpError(503, 'figure storage not configured')
    const base = resolve(root)
    const target = resolve(base, relPath)
    if (target !== base && !target.startsWith(`${base}${sep}`)) {
      throw new HttpError(500, 'candidate path invalid')
    }
    let bytes: Buffer
    try {
      bytes = await readFile(target)
    } catch {
      throw notFound('candidate image not found')
    }
    reply.header('cache-control', 'private, max-age=300')
    return reply.type(target.endsWith('.png') ? 'image/png' : 'image/jpeg').send(bytes)
  })

  app.post('/v1/admin/content/courses/:courseId/publish', async request => {
    await guard(request)
    const { courseId } = request.params as { courseId: string }
    return api.publishCourse(parseContentId(courseId, 'courseId'))
  })

  app.post('/v1/admin/content/media-assets/:assetId/ingest', async (request, reply) => {
    await guard(request)
    const { assetId } = request.params as { assetId: string }
    const body = request.body === undefined ? {} : asObject(request.body)
    const job = await api.enqueueIngest(parseAssetId(assetId), parseLanguage(body.language))
    return reply.code(202).send({ job })
  })

  app.get('/v1/admin/content/media-assets/:assetId/transcript', async request => {
    await guard(request)
    const { assetId } = request.params as { assetId: string }
    const query = asObject(request.query)
    return api.getTranscript(parseAssetId(assetId), {
      offset: queryInt(query, 'offset', 0, 0, 100_000),
      limit: queryInt(query, 'limit', 100, 1, 500),
    })
  })

  app.get('/v1/admin/content/pipeline/jobs', async request => {
    await guard(request)
    const query = asObject(request.query)
    const courseId = queryText(query, 'courseId')
    const assetId = queryText(query, 'assetId')
    return api.listJobs({
      ...(query.status === undefined ? {} : { status: parseJobStatus(query.status) }),
      ...(query.kind === undefined ? {} : { kind: parseJobKind(query.kind) }),
      ...(courseId === undefined ? {} : { courseId: parseContentId(courseId, 'courseId') }),
      ...(assetId === undefined ? {} : { assetId: parseAssetId(assetId) }),
      offset: queryInt(query, 'offset', 0, 0, 100_000),
      limit: queryInt(query, 'limit', 50, 1, 100),
    })
  })

  app.get('/v1/admin/content/pipeline/jobs/:jobId', async request => {
    await guard(request)
    const { jobId } = request.params as { jobId: string }
    return { job: await api.getJob(parseJobId(jobId)) }
  })

  app.post('/v1/admin/content/pipeline/jobs/:jobId/retry', async request => {
    await guard(request)
    const { jobId } = request.params as { jobId: string }
    return { job: await api.retryJob(parseJobId(jobId)) }
  })

  app.post('/v1/admin/content/pipeline/jobs/:jobId/cancel', async request => {
    await guard(request)
    const { jobId } = request.params as { jobId: string }
    return { job: await api.cancelJob(parseJobId(jobId)) }
  })
}
