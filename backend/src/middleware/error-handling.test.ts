import { describe, expect, it } from 'bun:test'
import { createErrorResponse, getErrorStatus, getSafeErrorMessage, STATUS_MESSAGES } from './error-handling'

describe('createErrorResponse', () => {
  it('returns standardized error response structure', () => {
    const response = createErrorResponse('Test error')
    expect(response).toEqual({
      success: false,
      data: null,
      error: 'Test error',
    })
  })

  it('preserves the exact message passed in', () => {
    const response = createErrorResponse('Validation failed: email is required')
    expect(response.error).toBe('Validation failed: email is required')
  })
})

describe('getSafeErrorMessage', () => {
  it('returns predefined message for known status codes', () => {
    expect(getSafeErrorMessage(400)).toBe('Bad request')
    expect(getSafeErrorMessage(401)).toBe('Unauthorized')
    expect(getSafeErrorMessage(403)).toBe('Forbidden')
    expect(getSafeErrorMessage(404)).toBe('Not found')
    expect(getSafeErrorMessage(500)).toBe('An unexpected error occurred')
    expect(getSafeErrorMessage(503)).toBe('Service temporarily unavailable')
  })

  it('returns generic message for unknown status codes', () => {
    expect(getSafeErrorMessage(418)).toBe('An unexpected error occurred')
    expect(getSafeErrorMessage(599)).toBe('An unexpected error occurred')
  })

  it('never returns sensitive information regardless of input', () => {
    const message = getSafeErrorMessage(500)
    expect(message).not.toContain('SELECT')
    expect(message).not.toContain('database')
    expect(message).not.toContain('password')
  })
})

describe('getErrorStatus', () => {
  it('extracts status from Error with status property', () => {
    const error = new Error('test') as Error & { status: number }
    error.status = 401
    expect(getErrorStatus(error)).toBe(401)
  })

  it('returns fallback for plain Error without status', () => {
    const error = new Error('test')
    expect(getErrorStatus(error, 500)).toBe(500)
  })

  it('returns fallback for non-Error values', () => {
    expect(getErrorStatus('string error', 500)).toBe(500)
    expect(getErrorStatus(null, 500)).toBe(500)
    expect(getErrorStatus(undefined, 500)).toBe(500)
    expect(getErrorStatus({ message: 'object' }, 500)).toBe(500)
  })

  it('uses provided fallback status', () => {
    expect(getErrorStatus(new Error('test'), 503)).toBe(503)
  })

  it('defaults fallback to 500 when not provided', () => {
    expect(getErrorStatus(new Error('test'))).toBe(500)
  })
})

describe('STATUS_MESSAGES', () => {
  it('has messages for common HTTP error codes', () => {
    const expectedCodes = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]
    for (const code of expectedCodes) {
      expect(STATUS_MESSAGES[code]).toBeDefined()
      expect(typeof STATUS_MESSAGES[code]).toBe('string')
    }
  })

  it('messages are generic and do not contain sensitive patterns', () => {
    const sensitivePatterns = [
      /select/i,
      /insert/i,
      /update/i,
      /delete/i,
      /from/i,
      /where/i,
      /password/i,
      /secret/i,
      /token/i,
      /api.?key/i,
    ]

    for (const message of Object.values(STATUS_MESSAGES)) {
      for (const pattern of sensitivePatterns) {
        expect(message).not.toMatch(pattern)
      }
    }
  })
})

describe('error message sanitization', () => {
  it('SQL injection attempts in error messages are never exposed', () => {
    const sqlErrors = [
      'Failed query: select "id" from "user" where "user"."email" = $1',
      'duplicate key value violates unique constraint',
      'relation "users" does not exist',
      'column "password_hash" of relation "user" does not exist',
    ]

    for (const _ of sqlErrors) {
      const safeMessage = getSafeErrorMessage(500)
      expect(safeMessage).toBe('An unexpected error occurred')
    }
  })

  it('database connection errors are never exposed', () => {
    const dbErrors = [
      'connection refused to host=localhost port=5432',
      'FATAL: password authentication failed for user "admin"',
      'SSL connection has been closed unexpectedly',
    ]

    for (const _ of dbErrors) {
      const safeMessage = getSafeErrorMessage(503)
      expect(safeMessage).toBe('Service temporarily unavailable')
    }
  })
})
