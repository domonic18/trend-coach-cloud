import { createHash, randomBytes } from 'node:crypto'

export type RandomIdPrefix = 'job' | 'tr' | 'chunk' | 'gen'

export function randomId(prefix: RandomIdPrefix): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`
}

/** apply 必须可重入：同一 generation 每次生成同一批核心表 ID。 */
function generationSalt(generationId: string): string {
  return createHash('sha256').update(generationId).digest('hex').slice(0, 8)
}

export function chapterIdFor(generationId: string, key: string): string {
  return `ch_${generationSalt(generationId)}_${key}`
}

export function knowledgePointIdFor(generationId: string, key: string): string {
  return `kp_${generationSalt(generationId)}_${key}`
}

export function draftSegmentIdFor(generationId: string, key: string): string {
  return `seg-${generationSalt(generationId)}-${key}`
}

/** 图示 ID 跨 apply/发布保持不变，正文里的 figure:<id> 才能在重放后仍可解析。 */
export function figureIdFor(generationId: string, key: string): string {
  return `fig_${generationSalt(generationId)}_${key}`
}

export function candidateIdFor(): string {
  return `cand_${randomBytes(8).toString('hex')}`
}
