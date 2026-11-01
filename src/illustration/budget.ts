import type { Pool } from 'pg'
import { codedConflict } from '../errors.js'

/** 单课 ¥10、组织月度 ¥300，单位为 micros（1 元 = 1_000_000）。 */
export const COURSE_IMAGE_BUDGET_MICROS = 10_000_000
export const ORG_MONTHLY_IMAGE_BUDGET_MICROS = 300_000_000
export const BUDGET_WARN_RATIO = 0.8

export interface ImageBudget {
  courseSpentMicros: number
  courseLimitMicros: number
  orgSpentMicros: number
  orgLimitMicros: number
}

export interface ImageBudgetState extends ImageBudget {
  warning: boolean
  exhausted: boolean
}

interface BudgetRow {
  course_spent: string | number | null
  org_spent: string | number | null
}

/** 单课按课程累计，组织额度按自然月；成本只读生成时落库的 cost_micros。 */
export async function readImageBudget(pool: Pool, courseId: string): Promise<ImageBudget> {
  const { rows } = await pool.query<BudgetRow>(
    `SELECT
       coalesce(sum(cost_micros) FILTER (WHERE course_id = $1), 0) AS course_spent,
       coalesce(sum(cost_micros) FILTER (
         WHERE created_at >= date_trunc('month', now())), 0) AS org_spent
     FROM ai_usage_events
     WHERE images > 0`,
    [courseId],
  )
  const row = rows[0]
  return {
    courseSpentMicros: Number(row?.course_spent ?? 0),
    courseLimitMicros: COURSE_IMAGE_BUDGET_MICROS,
    orgSpentMicros: Number(row?.org_spent ?? 0),
    orgLimitMicros: ORG_MONTHLY_IMAGE_BUDGET_MICROS,
  }
}

export function budgetState(budget: ImageBudget): ImageBudgetState {
  const courseRatio = budget.courseLimitMicros === 0
    ? 1
    : budget.courseSpentMicros / budget.courseLimitMicros
  const orgRatio = budget.orgLimitMicros === 0
    ? 1
    : budget.orgSpentMicros / budget.orgLimitMicros
  return {
    ...budget,
    warning: courseRatio >= BUDGET_WARN_RATIO || orgRatio >= BUDGET_WARN_RATIO,
    exhausted: budget.courseSpentMicros >= budget.courseLimitMicros
      || budget.orgSpentMicros >= budget.orgLimitMicros,
  }
}

export function canSpend(budget: ImageBudget, priceMicros: number): boolean {
  return budget.courseSpentMicros + priceMicros <= budget.courseLimitMicros
    && budget.orgSpentMicros + priceMicros <= budget.orgLimitMicros
}

export function imageBudgetError(budget: ImageBudget): never {
  throw codedConflict('image_budget_exceeded', 'image budget exceeded', {
    courseSpentMicros: budget.courseSpentMicros,
    courseLimitMicros: budget.courseLimitMicros,
    orgSpentMicros: budget.orgSpentMicros,
    orgLimitMicros: budget.orgLimitMicros,
  })
}

/** 入队/再生前的硬校验：预算已耗尽直接 409。 */
export async function assertImageBudget(
  pool: Pool,
  courseId: string,
  priceMicros: number,
): Promise<ImageBudget> {
  const budget = await readImageBudget(pool, courseId)
  if (!canSpend(budget, priceMicros)) imageBudgetError(budget)
  return budget
}
