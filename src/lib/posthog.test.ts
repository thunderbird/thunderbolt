/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createClient, type HttpClient } from '@/lib/http'
import type { HandleError } from '@/types/handle-errors'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { initPosthog, resetPosthogClient, sanitizeUrl, stripApiKeys, trackError } from './posthog'

type PosthogOptions = {
  before_send: (event: PosthogEvent) => PosthogEvent
}

type PosthogEvent = {
  event: string
  properties: Record<string, unknown>
}

const mockPosthogInit = mock()
const mockCaptureException = mock()
let capturedOptions: PosthogOptions | null = null

mock.module('posthog-js', () => ({
  default: {
    init: (...args: unknown[]) => {
      const [, options] = args
      // Always capture the options, even if PostHog client is cached
      capturedOptions = options as PosthogOptions
      const result = mockPosthogInit(...args)
      // Return a mock client with captureException method
      return {
        ...result,
        captureException: mockCaptureException,
      }
    },
    captureException: mockCaptureException,
  },
}))

const createMockHttpClient = (apiKey = 'test-key'): HttpClient => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        public_posthog_api_key: apiKey,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  return createClient({ fetch: mockFetch, prefixUrl: 'http://test-api.local' })
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
  // bun's mock.module is process-global; clear the client so later test
  // files don't inherit our stubbed posthog.
  resetPosthogClient()
})

describe('analytics sanitizeUrl', () => {
  it('replaces dynamic chat IDs with route params for pathnames', () => {
    expect(sanitizeUrl('/chats/123')).toBe('/chats/:chatThreadId')
    expect(sanitizeUrl('/chats/abc-123')).toBe('/chats/:chatThreadId')
  })

  it('replaces dynamic chat IDs and removes the query and hash', () => {
    const input = 'https://app.test/chats/abc-123?x=1#hash'
    const expected = 'https://app.test/chats/:chatThreadId'
    expect(sanitizeUrl(input)).toBe(expected)
  })

  it('removes OAuth callback credentials', () => {
    expect(sanitizeUrl('/oauth/callback?code=authorization-code&state=csrf-state')).toBe('/oauth/callback')
  })

  it('removes magic-link credentials', () => {
    expect(sanitizeUrl('/auth/verify?token=magic-link-token')).toBe('/auth/verify')
  })

  it('removes multiple query parameters and a hash', () => {
    expect(sanitizeUrl('/device?user_code=ABCD1234&client_id=thunderbird#approval')).toBe('/device')
  })

  it('preserves absolute and path-only URL forms', () => {
    expect(sanitizeUrl('https://app.test/settings?tab=account#profile')).toBe('https://app.test/settings')
    expect(sanitizeUrl('/settings?tab=account#profile')).toBe('/settings')
  })

  it('preserves the fallback behavior for unparseable values', () => {
    const input = 'http://[invalid-url?token=secret#hash'
    expect(sanitizeUrl(input)).toBe(input)
  })

  it('returns routes without query parameters unchanged', () => {
    expect(sanitizeUrl('/settings')).toBe('/settings')
    expect(sanitizeUrl('https://app.test/settings')).toBe('https://app.test/settings')
  })
})

describe('analytics before_send sanitization', () => {
  beforeEach(() => {
    resetPosthogClient()
    mockPosthogInit.mockReset()
    mockCaptureException.mockReset()
  })

  it('sanitizes $current_url, url, and $pathname when strings', async () => {
    const mockHttpClient = createMockHttpClient('test-key')
    await initPosthog(mockHttpClient)
    expect(capturedOptions).toBeTruthy()

    const event: PosthogEvent = {
      event: '$pageview',
      properties: {
        $current_url: 'https://app/chats/123?x=1',
        url: 'https://app/chats/456',
        $pathname: '/chats/789',
      },
    }

    const result = capturedOptions!.before_send(event)
    expect(result.properties.$current_url).toBe('https://app/chats/:chatThreadId')
    expect(result.properties.url).toBe('https://app/chats/:chatThreadId')
    expect(result.properties.$pathname).toBe('/chats/:chatThreadId')
  })

  it('sanitizes SDK URL properties on custom events', async () => {
    const mockHttpClient = createMockHttpClient('test-key')
    await initPosthog(mockHttpClient)
    expect(capturedOptions).toBeTruthy()

    const event: PosthogEvent = {
      event: 'chat_send_prompt',
      properties: {
        $current_url: 'https://app/chats/123?foo=bar&token=xyz#private',
        $referrer: 'https://referrer.test/chats/456?source=private#secret',
      },
    }

    const result = capturedOptions!.before_send(event)
    expect(result.properties.$current_url).toBe('https://app/chats/:chatThreadId')
    expect(result.properties.$referrer).toBe('https://referrer.test/chats/:chatThreadId')
  })

  it('ignores non-string URL-like properties', async () => {
    const mockHttpClient = createMockHttpClient('test-key')
    await initPosthog(mockHttpClient)
    expect(capturedOptions).toBeTruthy()

    const event: PosthogEvent = {
      event: '$pageleave',
      properties: {
        $current_url: 123,
        url: { href: '/chats/1' },
        $pathname: null,
      },
    }

    const result = capturedOptions!.before_send(event)
    expect(result.properties.$current_url).toBe(123)
    expect(result.properties.url).toEqual({ href: '/chats/1' })
    expect(result.properties.$pathname).toBeNull()
  })

  it('removes nested API keys and preserves other properties', () => {
    const properties: Record<string, unknown> = {
      model: {
        id: 'model-1',
        apiKey: 'secret',
        nested: [
          { apiKey: 'another-secret', provider: 'openai' },
          { apiKey: 'third-secret', provider: 'anthropic' },
        ],
      },
      attempts: 2,
    }

    expect(stripApiKeys(properties)).toBe(true)
    expect(properties).toEqual({
      model: {
        id: 'model-1',
        nested: [{ provider: 'openai' }, { provider: 'anthropic' }],
      },
      attempts: 2,
    })
  })

  it('reports when no API key was present', () => {
    expect(stripApiKeys({ model_id: 'model-1' })).toBe(false)
  })
})

describe('trackError test cases', () => {
  beforeEach(() => {
    resetPosthogClient()
    mockCaptureException.mockReset()
    mockPosthogInit.mockReset()
  })

  it('tracks non-PostHog errors with PostHog client', async () => {
    const mockHttpClient = createMockHttpClient('test-key')
    await initPosthog(mockHttpClient)

    const error: HandleError = {
      code: 'DATABASE_INIT_FAILED',
      message: 'Failed to initialize database',
      stackTrace: 'Error: Database connection failed\n    at initDb (db.ts:10:5)',
    }

    trackError(error)

    expect(mockCaptureException).toHaveBeenCalledWith('$exception', {
      $exception_type: 'DATABASE_INIT_FAILED',
      $exception_message: 'Failed to initialize database',
      $exception_stack: 'Error: Database connection failed\n    at initDb (db.ts:10:5)',
    })
  })

  it('includes context data when provided', async () => {
    const mockHttpClient = createMockHttpClient('test-key')
    await initPosthog(mockHttpClient)

    const error: HandleError = {
      code: 'MIGRATION_FAILED',
      message: 'Migration step 3 failed',
      originalError: new Error('SQL syntax error'),
    }

    const context = {
      userId: 'user-123',
      migrationVersion: 'v1.2.3',
      step: 3,
    }

    trackError(error, context)

    expect(mockCaptureException).toHaveBeenCalledWith('$exception', {
      $exception_type: 'MIGRATION_FAILED',
      $exception_message: 'Migration step 3 failed',
      $exception_stack: undefined,
      userId: 'user-123',
      migrationVersion: 'v1.2.3',
      step: 3,
    })
  })

  it('handles missing PostHog client gracefully', () => {
    // Test the case where PostHog client is null (simulating no initialization)
    // We can't easily reset the module variable, so we'll test the behavior
    // by calling trackError with a PostHog error code which should be skipped
    const error: HandleError = {
      code: 'POSTHOG_FETCH_FAILED',
      message: 'Failed to fetch PostHog configuration',
    }

    trackError(error)

    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('handles tracking errors gracefully without throwing', async () => {
    const mockHttpClient = createMockHttpClient('test-key')
    await initPosthog(mockHttpClient)
    mockCaptureException.mockImplementation(() => {
      throw new Error('PostHog tracking failed')
    })

    const error: HandleError = {
      code: 'TRAY_INIT_FAILED',
      message: 'Failed to initialize system tray',
    }

    expect(() => trackError(error)).not.toThrow()

    expect(mockCaptureException).toHaveBeenCalledWith('$exception', {
      $exception_type: 'TRAY_INIT_FAILED',
      $exception_message: 'Failed to initialize system tray',
      $exception_stack: undefined,
    })
  })

  it('tracks errors with minimal required fields', async () => {
    const mockHttpClient = createMockHttpClient('test-key')
    await initPosthog(mockHttpClient)

    const error: HandleError = {
      code: 'APP_DIR_CREATION_FAILED',
      message: 'Could not create app directory',
    }

    trackError(error)

    expect(mockCaptureException).toHaveBeenCalledWith('$exception', {
      $exception_type: 'APP_DIR_CREATION_FAILED',
      $exception_message: 'Could not create app directory',
      $exception_stack: undefined,
    })
  })
})
