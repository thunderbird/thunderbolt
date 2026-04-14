/** Base HTTP error with a status code. Integrates with safeErrorHandler middleware. */
class HttpError extends Error {
  readonly status: number

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HttpError'
    this.status = status
  }
}

/** 400 Bad Request — input validation failures. */
export class BadRequestError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, options)
    this.name = 'BadRequestError'
  }
}

/** 403 Forbidden — authorization failures (valid auth, insufficient permissions). */
export class ForbiddenError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 403, options)
    this.name = 'ForbiddenError'
  }
}

/** 422 Unprocessable Entity — request understood but cannot be processed (e.g. limit reached). */
export class UnprocessableError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 422, options)
    this.name = 'UnprocessableError'
  }
}
