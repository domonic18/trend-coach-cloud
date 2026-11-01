export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 需要机器可读错误码的管理端接口（图示未解析、图片预算超限）。 */
export class CodedHttpError extends HttpError {
  constructor(
    statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(statusCode, message)
    this.name = 'CodedHttpError'
  }
}

export const codedConflict = (
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): CodedHttpError => new CodedHttpError(409, code, message, details)

export const badRequest = (message: string): HttpError => new HttpError(400, message)
export const unauthorized = (message = 'unauthorized'): HttpError => new HttpError(401, message)
export const forbidden = (message = 'forbidden'): HttpError => new HttpError(403, message)
export const notFound = (message = 'not found'): HttpError => new HttpError(404, message)
export const conflict = (message = 'conflict'): HttpError => new HttpError(409, message)
export const unprocessable = (message = 'unprocessable entity'): HttpError => new HttpError(422, message)
export const tooManyRequests = (message = 'too many requests'): HttpError => new HttpError(429, message)
export const badGateway = (message = 'bad gateway'): HttpError => new HttpError(502, message)
export const serviceUnavailable = (message = 'service unavailable'): HttpError => new HttpError(503, message)
