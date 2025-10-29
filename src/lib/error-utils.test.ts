import { describe, expect, it } from 'bun:test'
import { createHandleError } from './error-utils'
import type { HandleErrorCode } from '@/types/handle-errors'

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
