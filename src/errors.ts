export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, message)
export const unauthorized = (message = 'unauthorized'): HttpError => new HttpError(401, message)
export const forbidden = (message = 'forbidden'): HttpError => new HttpError(403, message)
export const notFound = (message = 'not found'): HttpError => new HttpError(404, message)
export const conflict = (message = 'conflict'): HttpError => new HttpError(409, message)
export const tooManyRequests = (message = 'too many requests'): HttpError => new HttpError(429, message)
export const serviceUnavailable = (message = 'service unavailable'): HttpError => new HttpError(503, message)
