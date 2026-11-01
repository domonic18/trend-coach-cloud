import type { FastifyInstance } from 'fastify'
import type { AccountService } from '../accounts/service.js'
import type { AppConfig } from '../config.js'
import { badRequest, tooManyRequests } from '../errors.js'
import { requireSession } from '../http/principal.js'
import { asObject, optionalStringField } from '../http/validation.js'
import type { RateLimiter } from '../rate-limit.js'
import {
  boundedQuery,
  ContentService,
  type ContentStatus,
  type SegmentFilters,
  markdownField,
  parseContentId,
  parseSegmentId,
  parseStatus,
  positionField,
  secondsField,
  textField,
  titleField,
} from './service.js'

export interface ContentRouteDeps {
  content: ContentService
  accounts: AccountService
  config: AppConfig
  limiter: RateLimiter
}

function courseIdParam(raw: string): string {
  return parseContentId(raw, 'courseId')
}

function chapterIdParam(raw: string): string {
  return parseContentId(raw, 'chapterId')
}

function knowledgePointIdParam(raw: string): string {
  return parseContentId(raw, 'knowledgePointId')
}

function statusField(body: Record<string, unknown>): ContentStatus | undefined {
  return body.status === undefined ? undefined : parseStatus(body.status)
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

export function registerContentRoutes(app: FastifyInstance, deps: ContentRouteDeps): void {
  const { content, accounts, config, limiter } = deps
  const staff = (request: Parameters<typeof requireSession>[0]) =>
    requireSession(request, accounts, ['operator', 'admin'])
  const guard = async (request: Parameters<typeof staff>[0]): Promise<void> => {
    const principal = await staff(request)
    if (!limiter.take(`content:${principal.userId}`, config.rateLimitContentPerMinute)) {
      throw tooManyRequests()
    }
  }

  app.get('/v1/admin/content/courses', async request => {
    await guard(request)
    return content.listCourses()
  })

  app.post('/v1/admin/content/courses', async (request, reply) => {
    await guard(request)
    const body = asObject(request.body)
    const course = await content.createCourse({
      courseId: courseIdParam(String(body.courseId ?? '')),
      title: titleField(body),
      status: statusField(body) ?? 'draft',
    })
    return reply.code(201).send({ course })
  })

  app.get('/v1/admin/content/courses/:courseId', async request => {
    await guard(request)
    const { courseId } = request.params as { courseId: string }
    return content.getCourseTree(courseId)
  })

  app.patch('/v1/admin/content/courses/:courseId', async request => {
    await guard(request)
    const { courseId } = request.params as { courseId: string }
    const body = asObject(request.body)
    const title = optionalStringField(body, 'title', { min: 1, max: 200 })
    const status = statusField(body)
    if (title === undefined && status === undefined) {
      throw badRequest('at least one of title, status is required')
    }
    return {
      course: await content.patchCourse(courseId, {
        ...(title === undefined ? {} : { title }),
        ...(status === undefined ? {} : { status }),
      }),
    }
  })

  app.post('/v1/admin/content/courses/:courseId/chapters', async (request, reply) => {
    await guard(request)
    const { courseId } = request.params as { courseId: string }
    const body = asObject(request.body)
    const position = positionField(body)
    const chapter = await content.createChapter(courseId, {
      chapterId: chapterIdParam(String(body.chapterId ?? '')),
      title: titleField(body),
      ...(position === undefined ? {} : { position }),
    })
    return reply.code(201).send({ chapter })
  })

  app.patch('/v1/admin/content/courses/:courseId/chapters/:chapterId', async request => {
    await guard(request)
    const { courseId, chapterId } = request.params as { courseId: string; chapterId: string }
    const body = asObject(request.body)
    const title = optionalStringField(body, 'title', { min: 1, max: 200 })
    const position = positionField(body)
    if (title === undefined && position === undefined) {
      throw badRequest('at least one of title, position is required')
    }
    return {
      chapter: await content.patchChapter(courseId, chapterId, {
        ...(title === undefined ? {} : { title }),
        ...(position === undefined ? {} : { position }),
      }),
    }
  })

  app.post(
    '/v1/admin/content/courses/:courseId/chapters/:chapterId/knowledge-points',
    async (request, reply) => {
      await guard(request)
      const { courseId, chapterId } = request.params as { courseId: string; chapterId: string }
      const body = asObject(request.body)
      const position = positionField(body)
      const knowledgePoint = await content.createKnowledgePoint(courseId, chapterId, {
        knowledgePointId: knowledgePointIdParam(String(body.knowledgePointId ?? '')),
        title: titleField(body),
        ...(position === undefined ? {} : { position }),
      })
      return reply.code(201).send({ knowledgePoint })
    },
  )

  app.patch('/v1/admin/content/knowledge-points/:knowledgePointId', async request => {
    await guard(request)
    const { knowledgePointId } = request.params as { knowledgePointId: string }
    const body = asObject(request.body)
    const title = optionalStringField(body, 'title', { min: 1, max: 200 })
    const position = positionField(body)
    if (title === undefined && position === undefined) {
      throw badRequest('at least one of title, position is required')
    }
    return {
      knowledgePoint: await content.patchKnowledgePoint(knowledgePointId, {
        ...(title === undefined ? {} : { title }),
        ...(position === undefined ? {} : { position }),
      }),
    }
  })

  app.get('/v1/admin/content/knowledge-points/:knowledgePointId/article', async request => {
    await guard(request)
    const { knowledgePointId } = request.params as { knowledgePointId: string }
    return { article: await content.getArticle(knowledgePointId) }
  })

  app.put('/v1/admin/content/knowledge-points/:knowledgePointId/article', async request => {
    await guard(request)
    const { knowledgePointId } = request.params as { knowledgePointId: string }
    const body = asObject(request.body)
    const article = await content.putArticle(knowledgePointId, {
      markdown: markdownField(body),
      status: parseStatus(body.status),
    })
    return { article }
  })

  app.get('/v1/admin/content/segments', async request => {
    await guard(request)
    const query = asObject(request.query)
    const filters: SegmentFilters = {
      ...(query.courseId === undefined
        ? {}
        : { courseId: courseIdParam(String(query.courseId)) }),
      ...(query.knowledgePointId === undefined
        ? {}
        : { knowledgePointId: knowledgePointIdParam(String(query.knowledgePointId)) }),
      ...(query.status === undefined ? {} : { status: parseStatus(query.status) }),
      ...(query.query === undefined ? {} : { query: boundedQuery(query.query) as string }),
      offset: queryInt(query, 'offset', 0, 0, 100_000),
      limit: queryInt(query, 'limit', 50, 1, 100),
    }
    return content.listSegments(filters)
  })

  app.post('/v1/admin/content/segments', async (request, reply) => {
    await guard(request)
    const body = asObject(request.body)
    const segment = await content.createSegment({
      segmentId: parseSegmentId(String(body.segmentId ?? '')),
      courseId: courseIdParam(String(body.courseId ?? '')),
      chapterId: chapterIdParam(String(body.chapterId ?? '')),
      knowledgePointId: knowledgePointIdParam(String(body.knowledgePointId ?? '')),
      title: titleField(body),
      startSec: secondsField(body, 'startSec'),
      endSec: secondsField(body, 'endSec'),
      text: textField(body),
      status: statusField(body) ?? 'draft',
    })
    return reply.code(201).send({ segment })
  })

  app.patch('/v1/admin/content/segments/:segmentId', async request => {
    await guard(request)
    const { segmentId } = request.params as { segmentId: string }
    const body = asObject(request.body)
    const title = optionalStringField(body, 'title', { min: 1, max: 200 })
    const text = optionalStringField(body, 'text', { min: 1, max: 4000 })
    const status = statusField(body)
    const startSec = body.startSec === undefined ? undefined : secondsField(body, 'startSec')
    const endSec = body.endSec === undefined ? undefined : secondsField(body, 'endSec')
    if (
      title === undefined &&
      text === undefined &&
      status === undefined &&
      startSec === undefined &&
      endSec === undefined
    ) {
      throw badRequest('at least one field is required')
    }
    const segment = await content.patchSegment(segmentId, {
      ...(title === undefined ? {} : { title }),
      ...(text === undefined ? {} : { text }),
      ...(status === undefined ? {} : { status }),
      ...(startSec === undefined ? {} : { startSec }),
      ...(endSec === undefined ? {} : { endSec }),
    })
    return { segment }
  })

  app.post('/v1/admin/content/reindex', async request => {
    await guard(request)
    const body = request.body === undefined ? {} : asObject(request.body)
    const courseId = body.courseId === undefined ? undefined : courseIdParam(String(body.courseId))
    return content.reindex(courseId)
  })
}
