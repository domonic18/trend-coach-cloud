import type { Pool } from 'pg'
import type { Principal } from '../auth/service.js'
import { HttpError } from '../errors.js'
import { asObject, booleanField, intField } from '../http/validation.js'
import { parseKnowledgePointId } from '../catalog/service.js'

export interface ProgressInput {
  watchedSec: number
  completed: boolean
}

export interface ProgressOut {
  knowledgePointId: string
  watchedSec: number
  completed: boolean
  updatedAt: number
}

interface ProgressRow {
  watched_sec: number
  completed: boolean
  updated_at: Date
}

export function parseProgressBody(body: unknown): ProgressInput {
  const object = asObject(body)
  return {
    watchedSec: intField(object, 'watchedSec', { min: 0, max: 86400 }),
    completed: booleanField(object, 'completed'),
  }
}

export class ProgressService {
  constructor(private readonly pool: Pool) {}

  async report(principal: Principal, rawId: string, input: ProgressInput): Promise<ProgressOut> {
    const knowledgePointId = parseKnowledgePointId(rawId)
    const { rows: pointRows } = await this.pool.query(
      `SELECT 1
       FROM knowledge_points kp
       JOIN courses c ON c.course_id = kp.course_id
       WHERE kp.knowledge_point_id = $1 AND c.status = 'published'`,
      [knowledgePointId],
    )
    if (pointRows.length === 0) throw new HttpError(404, 'knowledge point not found')

    const { rows } = await this.pool.query<ProgressRow>(
      `INSERT INTO learning_progress (user_id, knowledge_point_id, device_id, watched_sec, completed)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, knowledge_point_id) DO UPDATE
       SET watched_sec = GREATEST(learning_progress.watched_sec, EXCLUDED.watched_sec),
           completed = learning_progress.completed OR EXCLUDED.completed,
           device_id = EXCLUDED.device_id,
           updated_at = now()
       RETURNING watched_sec, completed, updated_at`,
      [principal.userId, knowledgePointId, principal.deviceId, input.watchedSec, input.completed],
    )
    const row = rows[0]
    if (row === undefined) throw new HttpError(500, 'progress write failed')
    return {
      knowledgePointId,
      watchedSec: row.watched_sec,
      completed: row.completed,
      updatedAt: row.updated_at.getTime(),
    }
  }
}
