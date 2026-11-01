import { HttpError } from '../errors.js'
import { codePointLength } from '../http/validation.js'

export const MIN_PUBLISHED_QUESTIONS = 3
export const MAX_QUESTIONS = 5
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 6
export const MAX_PROMPT = 300
export const MAX_OPTION = 200
export const MAX_EXPLANATION = 500
export const QUESTION_ID = /^q_[A-Za-z0-9._-]{1,40}$/

export interface QuizQuestion {
  questionId: string
  prompt: string
  options: string[]
  answerIndex: number
  explanation: string
}

function fail(status: number, message: string): never {
  throw new HttpError(status, message)
}

/** 入参用 400；读已存数据用 500，避免把损坏题库当成客户端错误。 */
export function parseQuizQuestions(raw: unknown, errorStatus = 400): QuizQuestion[] {
  if (!Array.isArray(raw)) fail(errorStatus, 'quiz questions must be an array')
  if (raw.length < 1 || raw.length > MAX_QUESTIONS) {
    fail(errorStatus, `quiz questions must contain 1–${MAX_QUESTIONS} items`)
  }
  const seen = new Set<string>()
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      fail(errorStatus, `quiz question ${index} must be an object`)
    }
    const record = item as Record<string, unknown>

    const questionId = record.questionId
    if (typeof questionId !== 'string' || !QUESTION_ID.test(questionId)) {
      fail(errorStatus, `quiz question ${index} questionId invalid`)
    }
    if (seen.has(questionId)) fail(errorStatus, `quiz questionId duplicated: ${questionId}`)
    seen.add(questionId)

    const prompt = record.prompt
    if (typeof prompt !== 'string' || !fits(prompt, MAX_PROMPT)) {
      fail(errorStatus, `quiz question ${index} prompt must be 1–${MAX_PROMPT} characters`)
    }

    const options = record.options
    if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      fail(errorStatus, `quiz question ${index} options must contain ${MIN_OPTIONS}–${MAX_OPTIONS} items`)
    }
    const unique = new Set<string>()
    const normalized = options.map((option, optionIndex) => {
      if (typeof option !== 'string' || !fits(option, MAX_OPTION)) {
        fail(errorStatus, `quiz question ${index} option ${optionIndex} must be 1–${MAX_OPTION} characters`)
      }
      if (unique.has(option)) fail(errorStatus, `quiz question ${index} option duplicated`)
      unique.add(option)
      return option
    })

    const answerIndex = record.answerIndex
    if (typeof answerIndex !== 'number' || !Number.isInteger(answerIndex)
      || answerIndex < 0 || answerIndex >= normalized.length) {
      fail(errorStatus, `quiz question ${index} answerIndex out of range`)
    }

    const explanation = record.explanation
    if (typeof explanation !== 'string' || !fits(explanation, MAX_EXPLANATION)) {
      fail(errorStatus, `quiz question ${index} explanation must be 1–${MAX_EXPLANATION} characters`)
    }

    return { questionId, prompt, options: normalized, answerIndex, explanation }
  })
}

export function assertPublishableQuestions(questions: QuizQuestion[]): void {
  if (questions.length < MIN_PUBLISHED_QUESTIONS) {
    throw new HttpError(
      400,
      `published quiz requires ${MIN_PUBLISHED_QUESTIONS}–${MAX_QUESTIONS} questions`,
    )
  }
}

function fits(value: string, max: number): boolean {
  const length = codePointLength(value.trim())
  return length >= 1 && length <= max
}
