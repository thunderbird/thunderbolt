/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { Elysia } from 'elysia'
import {
  createErrorResponse,
  getErrorStatus,
  getSafeErrorMessage,
  getSafeLogMessage,
  safeErrorHandler,
  type ErrorResponse,
} from './error-handling'

describe('createErrorResponse', () => {
  it('returns standardized error response structure', () => {
    const response = createErrorResponse('Test error')
    expect(response).toEqual({
      success: false,
      data: null,
      error: 'Test error',
    })
  })
})

describe('getSafeErrorMessage', () => {
  it('returns standard HTTP reason phrase for known status codes', () => {
    expect(getSafeErrorMessage(400)).toBe('Bad Request')
    expect(getSafeErrorMessage(401)).toBe('Unauthorized')
    expect(getSafeErrorMessage(403)).toBe('Forbidden')
    expect(getSafeErrorMessage(404)).toBe('Not Found')
    expect(getSafeErrorMessage(500)).toBe('Internal Server Error')
    expect(getSafeErrorMessage(503)).toBe('Service Unavailable')
  })

  it('returns generic message for unknown status codes', () => {
    expect(getSafeErrorMessage(599)).toBe('An unexpected error occurred')
  })
})

describe('getErrorStatus', () => {
  it('extracts status from Error with status property', () => {
    const error = new Error('test') as Error & { status: number }
    error.status = 401
    expect(getErrorStatus(error)).toBe(401)
  })

  it('returns fallback for plain Error without status', () => {
    expect(getErrorStatus(new Error('test'), 500)).toBe(500)
  })

  it('returns fallback for non-Error values', () => {
    expect(getErrorStatus('string error', 500)).toBe(500)
    expect(getErrorStatus(null, 500)).toBe(500)
    expect(getErrorStatus(undefined, 500)).toBe(500)
  })

  it('defaults fallback to 500', () => {
    expect(getErrorStatus(new Error('test'))).toBe(500)
  })
})

describe('getSafeLogMessage', () => {
  it('extracts only the parameterized SQL from DrizzleQueryError', () => {
    const query = 'select "id" from "user" where "user"."email" = $1 limit $2'
    const error = new DrizzleQueryError(query, ['chris@example.com', 1])

    const message = getSafeLogMessage(error)
    expect(message).toBe(`Failed query: ${query}`)
    expect(message).not.toContain('chris@example.com')
  })

  it('returns message unchanged for regular errors', () => {
    expect(getSafeLogMessage(new Error('connection refused'))).toBe('connection refused')
  })

  it('stringifies non-Error values', () => {
    expect(getSafeLogMessage('raw string')).toBe('raw string')
    expect(getSafeLogMessage(42)).toBe('42')
  })
})

/**
 * Helper to create a test app with safeErrorHandler and a route that throws.
 */
const createTestApp = (throwFn: () => never) => new Elysia().onError(safeErrorHandler).get('/test', () => throwFn())

describe('safeErrorHandler', () => {
  it('returns safe error response and correct status for thrown errors', async () => {
    const app = createTestApp(() => {
      throw new Error('database connection string: postgres://admin:secret@localhost')
    })

    const res = await app.handle(new Request('http://localhost/test'))
    const body: ErrorResponse = await res.json()

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.error).toBe('Internal Server Error')
    expect(body.error).not.toContain('secret')
    expect(body.error).not.toContain('postgres')
  })

  it('uses status from error when present', async () => {
    const app = createTestApp(() => {
      const error = new Error('Not allowed') as Error & { status: number }
      error.status = 403
      throw error
    })

    const res = await app.handle(new Request('http://localhost/test'))
    const body: ErrorResponse = await res.json()

    expect(res.status).toBe(403)
    expect(body.error).toBe('Forbidden')
  })

  it('logs route, message, stack, and cause for regular errors', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    const cause = new Error('connection refused')
    const app = createTestApp(() => {
      throw new Error('fetch failed', { cause })
    })

    await app.handle(new Request('http://localhost/test'))

    const calls = errorSpy.mock.calls.map((args) => args[0])
    expect(calls[0]).toContain('[500] GET /test')
    expect(calls[0]).toContain('fetch failed')
    // Stack trace logged for regular errors
    expect(calls.some((c) => typeof c === 'string' && c.includes('error-handling.test.ts'))).toBe(true)
    // Cause logged
    expect(calls.some((c) => c === 'Caused by:')).toBe(true)

    errorSpy.mockRestore()
  })

  it('redacts DrizzleQueryError params from logs and suppresses stack', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    const app = createTestApp(() => {
      throw new DrizzleQueryError('select "id" from "user" where "user"."email" = $1 limit $2', [
        'chris@example.com',
        1,
      ])
    })

    await app.handle(new Request('http://localhost/test'))

    const logged = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(logged).toContain('Failed query')
    expect(logged).toContain('$1')
    expect(logged).not.toContain('chris@example.com')
    // Stack trace suppressed for DrizzleQueryError (it embeds params in first line)
    expect(logged).not.toContain('at queryWithCache')
    expect(logged).not.toContain('DrizzleQueryError:')

    errorSpy.mockRestore()
  })

  it('handles non-Error thrown values', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    const app = new Elysia().onError(safeErrorHandler).get('/test', () => {
      throw 'raw string error'
    })

    const res = await app.handle(new Request('http://localhost/test'))
    const body: ErrorResponse = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toBe('Internal Server Error')
    expect(body.error).not.toContain('raw string error')

    errorSpy.mockRestore()
  })
})
