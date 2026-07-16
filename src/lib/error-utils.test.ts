/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  createHandleError,
  getErrorRetryable,
  getErrorStatusCode,
  isAcpSessionBusyError,
  isContentRejectionError,
  isContextOverflowError,
  isRateLimitError,
} from './error-utils'
import type { HandleErrorCode } from '@/types/handle-errors'

describe('isRateLimitError', () => {
  it('detects 429 from JSON response body (DefaultChatTransport path)', () => {
    const error = new Error(JSON.stringify({ error: 'API call failed', statusCode: 429 }))
    expect(isRateLimitError(error)).toBe(true)
  })

  it('detects 429 even when error message text is generic', () => {
    const error = new Error(JSON.stringify({ error: 'Request failed', statusCode: 429 }))
    expect(isRateLimitError(error)).toBe(true)
  })

  it('does not match non-429 status codes', () => {
    const error = new Error(JSON.stringify({ error: 'Server error', statusCode: 500 }))
    expect(isRateLimitError(error)).toBe(false)
  })

  it('falls back to string matching for "too many requests"', () => {
    const error = new Error('Too many requests. Please try again later.')
    expect(isRateLimitError(error)).toBe(true)
  })

  it('string matching is case-insensitive', () => {
    const error = new Error('TOO MANY REQUESTS')
    expect(isRateLimitError(error)).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isRateLimitError(new Error('Network timeout'))).toBe(false)
  })

  it('content rejection is not a rate limit', () => {
    const error = new Error(JSON.stringify({ error: 'content.str: Input should be a valid string', status: 400 }))
    expect(isRateLimitError(error)).toBe(false)
  })

  it('returns false for null', () => {
    expect(isRateLimitError(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isRateLimitError(undefined)).toBe(false)
  })

  it('returns false for error with empty message', () => {
    expect(isRateLimitError(new Error(''))).toBe(false)
  })

  it('detects 429 via status field (aiFetchStreamingResponse path)', () => {
    const error = new Error(JSON.stringify({ error: 'Rate limited', status: 429 }))
    expect(isRateLimitError(error)).toBe(true)
  })

  it('does not match status 429 in non-JSON string', () => {
    const error = new Error('status 429 encountered')
    expect(isRateLimitError(error)).toBe(false)
  })

  it('returns false for malformed JSON that does not contain "too many requests"', () => {
    const error = new Error('{invalid json')
    expect(isRateLimitError(error)).toBe(false)
  })

  it('falls through to string match when JSON has no status fields', () => {
    const error = new Error(JSON.stringify({ error: 'too many requests', code: 'RATE_LIMITED' }))
    expect(isRateLimitError(error)).toBe(true)
  })
})

describe('createHandleError', () => {
  it('creates HandleError with required fields only', () => {
    const error = createHandleError('DATABASE_INIT_FAILED', 'Failed to initialize database')

    expect(error).toEqual({
      code: 'DATABASE_INIT_FAILED',
      message: 'Failed to initialize database',
      originalError: undefined,
      stackTrace: undefined,
    })
  })

  it('creates HandleError with originalError when provided', () => {
    const originalError = new Error('Connection timeout')
    const error = createHandleError('MIGRATION_FAILED', 'Migration failed', originalError)

    expect(error.code).toBe('MIGRATION_FAILED')
    expect(error.message).toBe('Migration failed')
    expect(error.originalError).toBe(originalError)
    expect(error.stackTrace).toBe(originalError.stack)
  })

  it('adds stack trace when originalError is an Error instance', () => {
    const originalError = new Error('SQL syntax error')
    const error = createHandleError('MIGRATION_FAILED', 'Migration step 3 failed', originalError)

    expect(error.code).toBe('MIGRATION_FAILED')
    expect(error.message).toBe('Migration step 3 failed')
    expect(error.originalError).toBe(originalError)
    expect(error.stackTrace).toBe(originalError.stack)
  })

  it('handles non-Error originalError without stack trace', () => {
    const originalError = { status: 500, response: 'Internal Server Error' }
    const error = createHandleError('UNKNOWN_ERROR', 'Something went wrong', originalError)

    expect(error).toEqual({
      code: 'UNKNOWN_ERROR',
      message: 'Something went wrong',
      originalError,
      stackTrace: undefined,
    })
  })

  it('handles null originalError', () => {
    const error = createHandleError('TRAY_INIT_FAILED', 'Failed to initialize tray', null)

    expect(error).toEqual({
      code: 'TRAY_INIT_FAILED',
      message: 'Failed to initialize tray',
      originalError: null,
      stackTrace: undefined,
    })
  })

  it('handles undefined originalError', () => {
    const error = createHandleError('APP_DIR_CREATION_FAILED', 'Could not create directory', undefined)

    expect(error).toEqual({
      code: 'APP_DIR_CREATION_FAILED',
      message: 'Could not create directory',
      originalError: undefined,
      stackTrace: undefined,
    })
  })

  it('works with all HandleErrorCode types', () => {
    const codes: HandleErrorCode[] = [
      'MIGRATION_FAILED',
      'DATABASE_INIT_FAILED',
      'RECONCILE_DEFAULTS_FAILED',
      'TRAY_INIT_FAILED',
      'POSTHOG_FETCH_FAILED',
      'APP_DIR_CREATION_FAILED',
      'DATABASE_PATH_FAILED',
      'UNKNOWN_ERROR',
    ]

    codes.forEach((code) => {
      const error = createHandleError(code, `Test error for ${code}`)
      expect(error.code).toBe(code)
      expect(error.message).toBe(`Test error for ${code}`)
    })
  })

  it('preserves Error instance properties in originalError', () => {
    const originalError = new Error('Network error')
    originalError.name = 'NetworkError'
    originalError.cause = 'Connection refused'

    const error = createHandleError('UNKNOWN_ERROR', 'Network operation failed', originalError)

    expect(error.originalError).toBe(originalError)
    expect((error.originalError as Error).name).toBe('NetworkError')
    expect((error.originalError as Error).cause).toBe('Connection refused')
    expect(error.stackTrace).toBe(originalError.stack)
  })

  it('handles Error with custom properties', () => {
    const originalError = new Error('Custom error')
    // @ts-ignore - adding custom property for testing
    originalError.customProperty = 'test value'

    const error = createHandleError('UNKNOWN_ERROR', 'Custom error occurred', originalError)

    expect(error.originalError).toBe(originalError)
    expect((error.originalError as Error & { customProperty: string }).customProperty).toBe('test value')
    expect(error.stackTrace).toBe(originalError.stack)
  })

  it('handles empty string message', () => {
    const error = createHandleError('UNKNOWN_ERROR', '')

    expect(error).toEqual({
      code: 'UNKNOWN_ERROR',
      message: '',
      originalError: undefined,
      stackTrace: undefined,
    })
  })

  it('handles very long error messages', () => {
    const longMessage = 'A'.repeat(1000)
    const error = createHandleError('UNKNOWN_ERROR', longMessage)

    expect(error.message).toBe(longMessage)
    expect(error.message.length).toBe(1000)
  })
})

describe('getErrorStatusCode', () => {
  it('reads `status` from a serialized stream error', () => {
    expect(getErrorStatusCode(new Error(JSON.stringify({ error: 'Bad Request', status: 400 })))).toBe(400)
  })

  it('reads `statusCode` (DefaultChatTransport path)', () => {
    expect(getErrorStatusCode(new Error(JSON.stringify({ error: 'x', statusCode: 422 })))).toBe(422)
  })

  it('is undefined for a non-JSON message (e.g. a bare "Bad Request")', () => {
    expect(getErrorStatusCode(new Error('Bad Request'))).toBeUndefined()
  })

  it('is undefined for null', () => {
    expect(getErrorStatusCode(null)).toBeUndefined()
  })
})

describe('isContentRejectionError', () => {
  it('detects the file-part rejection 400 (e.g. content.str)', () => {
    expect(isContentRejectionError(new Error(JSON.stringify({ error: 'Bad Request', status: 400 })))).toBe(true)
  })

  it('detects a 422 (the tag minted for a file-part UnsupportedFunctionalityError)', () => {
    expect(isContentRejectionError(new Error(JSON.stringify({ error: 'x', statusCode: 422 })))).toBe(true)
  })

  it('does NOT treat auth (401/403) as a content rejection', () => {
    expect(isContentRejectionError(new Error(JSON.stringify({ error: 'Unauthorized', status: 401 })))).toBe(false)
    expect(isContentRejectionError(new Error(JSON.stringify({ error: 'Forbidden', status: 403 })))).toBe(false)
  })

  it('does NOT treat a timeout (408) or not-found (404) as a content rejection', () => {
    expect(isContentRejectionError(new Error(JSON.stringify({ error: 'Request Timeout', status: 408 })))).toBe(false)
    expect(isContentRejectionError(new Error(JSON.stringify({ error: 'Not Found', status: 404 })))).toBe(false)
  })

  it('does NOT treat a 5xx, rate limit, or context overflow as a content rejection', () => {
    expect(isContentRejectionError(new Error(JSON.stringify({ error: 'Server error', status: 500 })))).toBe(false)
    expect(isContentRejectionError(new Error(JSON.stringify({ error: 'Too many requests', status: 429 })))).toBe(false)
    expect(isContentRejectionError(new Error(JSON.stringify({ error: 'prompt is too long', status: 400 })))).toBe(false)
  })

  it('returns false for null / no status', () => {
    expect(isContentRejectionError(null)).toBe(false)
    expect(isContentRejectionError(new Error('Network timeout'))).toBe(false)
  })
})

describe('getErrorRetryable', () => {
  it('reads the SDK isRetryable verdict from the serialized envelope', () => {
    expect(getErrorRetryable(new Error(JSON.stringify({ error: 'x', status: 400, isRetryable: false })))).toBe(false)
    expect(getErrorRetryable(new Error(JSON.stringify({ error: 'x', status: 408, isRetryable: true })))).toBe(true)
  })

  it('is undefined when no isRetryable field is present', () => {
    expect(getErrorRetryable(new Error(JSON.stringify({ error: 'x', status: 500 })))).toBeUndefined()
    expect(getErrorRetryable(new Error('Network timeout'))).toBeUndefined()
    expect(getErrorRetryable(null)).toBeUndefined()
  })
})

describe('isAcpSessionBusyError', () => {
  it('detects Zeroclaw / ACP "active prompt turn" busy rejects', () => {
    expect(
      isAcpSessionBusyError(new Error('Session already has an active prompt turn: 50be29d3-97bd-4bcc-8012-dd7e0a160ac3')),
    ).toBe(true)
    expect(
      isAcpSessionBusyError(
        new Error(JSON.stringify({ error: 'Session already has an active prompt turn: sess-1', status: 500 })),
      ),
    ).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isAcpSessionBusyError(new Error('Network timeout'))).toBe(false)
    expect(isAcpSessionBusyError(new Error(JSON.stringify({ error: 'Server error', status: 500 })))).toBe(false)
    expect(isAcpSessionBusyError(null)).toBe(false)
  })
})

describe('isContextOverflowError', () => {
  it("detects Anthropic's 'prompt is too long' overflow", () => {
    const error = new Error(
      JSON.stringify({ error: 'prompt is too long: 250000 tokens > 200000 maximum', status: 400 }),
    )
    expect(isContextOverflowError(error)).toBe(true)
  })

  it("detects OpenAI's context_length_exceeded", () => {
    const error = new Error(JSON.stringify({ error: 'context_length_exceeded', statusCode: 400 }))
    expect(isContextOverflowError(error)).toBe(true)
  })

  it("detects 'maximum context length' phrasing", () => {
    expect(isContextOverflowError(new Error("This model's maximum context length is 128000 tokens"))).toBe(true)
  })

  it('does not match a content rejection', () => {
    const error = new Error(JSON.stringify({ error: 'content.str: Input should be a valid string', status: 400 }))
    expect(isContextOverflowError(error)).toBe(false)
  })

  it('does not match a rate limit', () => {
    expect(isContextOverflowError(new Error('Too many requests'))).toBe(false)
  })

  it('returns false for null', () => {
    expect(isContextOverflowError(null)).toBe(false)
  })
})
