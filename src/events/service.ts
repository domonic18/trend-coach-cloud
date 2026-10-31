import type { Pool } from 'pg'
import type { Principal } from '../auth/service.js'
import { badRequest } from '../errors.js'
import { asObject, codePointLength } from '../http/validation.js'

const EVENT_ID = /^[A-Za-z0-9._:-]{8,64}$/
const SEGMENT_ID = /^seg-[A-Za-z0-9._-]+$/
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000

const ALLOWED_FIELDS: Record<string, ReadonlySet<string>> = {
  search_requested: new Set(['durationMs', 'topK', 'hits', 'empty']),
  citation_clicked: new Set(['segmentId']),
  player_started: new Set(['startupMs', 'autoplayBlocked']),
}

export interface EventInput {
  eventId: string
  name: string
  occurredAt: number
  props: Record<string, unknown>
}

function intProp(props: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = props[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`props.${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

function boolProp(props: Record<string, unknown>, key: string): boolean {
  const value = props[key]
  if (typeof value !== 'boolean') throw badRequest(`props.${key} must be a boolean`)
  return value
}

function normalizeProps(name: string, props: Record<string, unknown>): Record<string, unknown> {
  const allowed = ALLOWED_FIELDS[name]
  if (allowed === undefined) throw badRequest('event name not allowed')
  for (const key of Object.keys(props)) {
    if (!allowed.has(key)) throw badRequest(`props.${key} not allowed`)
  }
  switch (name) {
    case 'search_requested':
      return {
        durationMs: intProp(props, 'durationMs', 0, 60_000),
        topK: intProp(props, 'topK', 1, 20),
        hits: intProp(props, 'hits', 0, 20),
        empty: boolProp(props, 'empty'),
      }
    case 'citation_clicked': {
      const segmentId = props.segmentId
      if (typeof segmentId !== 'string' || !SEGMENT_ID.test(segmentId) || codePointLength(segmentId) > 80) {
        throw badRequest('props.segmentId invalid')
      }
      return { segmentId }
    }
    case 'player_started':
      return {
        startupMs: intProp(props, 'startupMs', 0, 60_000),
        autoplayBlocked: boolProp(props, 'autoplayBlocked'),
      }
    default:
      throw badRequest('event name not allowed')
  }
}

export function parseEventBody(body: unknown): EventInput {
  const object = asObject(body)
  const eventId = object.eventId
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) throw badRequest('eventId invalid')
  const name = object.name
  if (typeof name !== 'string' || ALLOWED_FIELDS[name] === undefined) throw badRequest('event name not allowed')
  const now = Date.now()
  const occurredAt = object.occurredAt === undefined ? now : object.occurredAt
  if (typeof occurredAt !== 'number' || !Number.isInteger(occurredAt)) throw badRequest('occurredAt must be ms timestamp')
  if (occurredAt > now + MAX_CLOCK_SKEW_MS || occurredAt < now - MAX_EVENT_AGE_MS) {
    throw badRequest('occurredAt out of range')
  }
  const props = object.props === undefined ? {} : asObject(object.props)
  return { eventId, name, occurredAt, props: normalizeProps(name, props) }
}

export class EventService {
  constructor(private readonly pool: Pool) {}

  async record(principal: Principal, deviceIdHash: string, event: EventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO events (event_id, event_name, user_id, device_id_hash, props, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.name, principal.userId, deviceIdHash, event.props, new Date(event.occurredAt)],
    )
  }
}
