/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
