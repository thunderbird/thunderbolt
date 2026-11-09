/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { deleteSetting, updateSettings } from '@/dal/settings'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createClient, type HttpClient } from '@/lib/http'
import type { HandleError } from '@/types/handle-errors'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { PostHog } from 'posthog-js'
import {
  initPosthog,
  getAnalyticsUrl,
  resetPosthogClient,
  sanitizeUrl,
  setCapturing,
  shouldCapture,
  stripPrivateAnalyticsProperties,
  trackError,
  trackEvent,
} from './posthog'

type PosthogOptions = {
  before_send: (event: PosthogEvent) => PosthogEvent | null
  opt_out_capturing_by_default: boolean
}

type PosthogEvent = {
  event: string
  properties: Record<string, unknown>
}

const mockPosthogInit = mock()
const mockCaptureException = mock()
const mockCapture = mock()
let sdkOptedOut = false
const mockOptOut = mock(() => {
  sdkOptedOut = true
})
const mockOptIn = mock(() => {
  sdkOptedOut = false
})
let capturedOptions: PosthogOptions | null = null

mock.module('posthog-js', () => ({
  default: {
    init: (...args: unknown[]) => {
      const [, options] = args
      // Always capture the options, even if PostHog client is cached
      capturedOptions = options as PosthogOptions
      const result = mockPosthogInit(...args)
      // A mock client: no saved consent choice unless a test returns one, and a captureException method.
      return {
        has_opted_out_capturing: () => sdkOptedOut,
        opt_in_capturing: mockOptIn,
        opt_out_capturing: mockOptOut,
        captureException: mockCaptureException,
        capture: (...captureArgs: unknown[]) => {
          if (!sdkOptedOut) {
            mockCapture(...captureArgs)
          }
        },
        ...result,
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

beforeEach(() => {
  sdkOptedOut = false
  mockOptIn.mockClear()
  mockOptOut.mockClear()
})

afterAll(async () => {
  await teardownTestDatabase()
  // bun's mock.module is process-global; clear the client so later test
  // files don't inherit our stubbed posthog.
  resetPosthogClient()
})

describe('analytics destination', () => {
  it('uses Thunderbolt telemetry when no app server is configured', () => {
    expect(getAnalyticsUrl('')).toBe('https://api.thunderbolt.io/v1')
  })

  it('preserves self-hosted analytics and normalizes trailing slashes', () => {
    expect(getAnalyticsUrl('https://my-server.example/v1///')).toBe('https://my-server.example/v1')
    expect(getAnalyticsUrl('/v1')).toBe('/v1')
  })
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

  it.each([
    ['/projects/private-project-id', '/projects/:projectId'],
    ['/apps/private-app-id', '/apps/:appId'],
  ])('removes synced row IDs from %s', (pathname, expected) => {
    expect(sanitizeUrl(pathname)).toBe(expected)
    expect(sanitizeUrl(`https://app.test${pathname}/?token=secret#fragment`)).toBe(`https://app.test${expected}`)
  })

  it('removes OAuth callback credentials', () => {
    expect(sanitizeUrl('/oauth/callback?code=authorization-code&state=csrf-state')).toBe('/oauth/callback')
  })

  it('removes OpenRouter flow nonces and authorization parameters, including trailing slash callbacks', () => {
    expect(sanitizeUrl('/oauth/openrouter/secret-nonce?code=secret-code&state=secret-state')).toBe(
      '/oauth/openrouter/:flowId',
    )
    expect(sanitizeUrl('/oauth/tinfoil/secret-nonce?code=secret-code&state=secret-state')).toBe(
      '/oauth/tinfoil/:flowId',
    )
    expect(sanitizeUrl('https://app.test/oauth/openrouter/secret-nonce/?code=secret-code#fragment')).toBe(
      'https://app.test/oauth/openrouter/:flowId',
    )
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

  it('discards unparseable URL values instead of retaining embedded secrets', () => {
    expect(sanitizeUrl('http://[invalid-url?token=secret#hash')).toBe('/unknown')
  })

  it('removes embedded URL credentials before normalizing route identifiers', () => {
    expect(sanitizeUrl('https://private-user:private-password@app.test/chats/private-id?token=secret')).toBe(
      'https://app.test/chats/:chatThreadId',
    )
  })

  it('returns routes without query parameters unchanged', () => {
    expect(sanitizeUrl('/settings')).toBe('/settings')
    expect(sanitizeUrl('https://app.test/settings')).toBe('https://app.test/settings')
  })
})

describe('analytics consent', () => {
  const optIn = mock()
  const optOut = mock()
  /** A client whose saved choice on this device is opted out, or not. */
  const clientWithSavedChoice = (isOptedOut: boolean) => ({
    has_opted_out_capturing: () => isOptedOut,
    opt_in_capturing: optIn,
    opt_out_capturing: optOut,
  })

  beforeEach(async () => {
    await updateSettings(getDb(), { data_collection: true })
    useLocalSettingsStore.setState({ syncEnabled: false })
    resetPosthogClient()
    mockPosthogInit.mockReset()
    optIn.mockReset()
    optOut.mockReset()
    await updateSettings(getDb(), { data_collection: true })
    useLocalSettingsStore.setState({ syncEnabled: false })
  })

  afterEach(async () => {
    await updateSettings(getDb(), { data_collection: true })
    useLocalSettingsStore.setState({ syncEnabled: false })
  })

  it.each([
    { dataCollection: true, syncEnabled: false, hasSynced: false, expected: true },
    { dataCollection: true, syncEnabled: true, hasSynced: true, expected: true },
    { dataCollection: true, syncEnabled: true, hasSynced: false, expected: false },
    { dataCollection: false, syncEnabled: false, hasSynced: false, expected: false },
    { dataCollection: false, syncEnabled: true, hasSynced: true, expected: false },
  ])(
    'captures only with the setting on, and once synced when sync is on: %o',
    ({ dataCollection, syncEnabled, hasSynced, expected }) => {
      expect(shouldCapture({ dataCollection, syncEnabled, hasSynced })).toBe(expected)
    },
  )

  it("opts in over a saved opt-out, without an `$opt_in` event, since it isn't the user's action", () => {
    setCapturing(clientWithSavedChoice(true) as unknown as PostHog, true)
    expect(optIn).toHaveBeenCalledWith({ captureEventName: false })
    expect(optOut).not.toHaveBeenCalled()
  })

  it('opts out over a saved opt-in', () => {
    setCapturing(clientWithSavedChoice(false) as unknown as PostHog, false)
    expect(optOut).toHaveBeenCalledTimes(1)
    expect(optIn).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'leaves a device alone when its saved choice already matches (capturing %p)',
    (isCapturing) => {
      setCapturing(clientWithSavedChoice(!isCapturing) as unknown as PostHog, isCapturing)
      expect(optIn).not.toHaveBeenCalled()
      expect(optOut).not.toHaveBeenCalled()
    },
  )

  it('starts capturing with the setting on, clearing an opt-out saved on this device', async () => {
    mockPosthogInit.mockReturnValue(clientWithSavedChoice(true))
    await initPosthog(createMockHttpClient())
    expect(mockPosthogInit.mock.calls[0][1]).toMatchObject({ opt_out_capturing_by_default: false })
    expect(optIn).toHaveBeenCalledTimes(1)
  })

  it('starts opted out with the setting off', async () => {
    await updateSettings(getDb(), { data_collection: false })
    mockPosthogInit.mockReturnValue(clientWithSavedChoice(false))
    await initPosthog(createMockHttpClient())
    expect(mockPosthogInit.mock.calls[0][1]).toMatchObject({ opt_out_capturing_by_default: true })
    expect(optOut).toHaveBeenCalledTimes(1)
  })

  it('starts opted out on a device with sync on that has not synced yet, whose setting is only a seeded guess', async () => {
    useLocalSettingsStore.setState({ syncEnabled: true })
    mockPosthogInit.mockReturnValue(clientWithSavedChoice(false))
    await initPosthog(createMockHttpClient())
    expect(mockPosthogInit.mock.calls[0][1]).toMatchObject({ opt_out_capturing_by_default: true })
    expect(optOut).toHaveBeenCalledTimes(1)
  })

  it('starts opted out while the setting has no row', async () => {
    await deleteSetting(getDb(), 'data_collection')
    await initPosthog(createMockHttpClient())
    expect(mockPosthogInit.mock.calls[0][1]).toMatchObject({ opt_out_capturing_by_default: true })
  })
})

describe('analytics before_send sanitization', () => {
  beforeEach(() => {
    resetPosthogClient()
    mockPosthogInit.mockReset()
    mockCaptureException.mockReset()
  })

  it('starts a fresh device-only analytics namespace without resetting consent on subsequent boots', async () => {
    sessionStorage.setItem('thunderbolt_pending_anon_id', 'previous-account-id')
    sdkOptedOut = true
    await updateSettings(getDb(), { data_collection: false })
    await initPosthog(createMockHttpClient('test-key'))
    const firstOptions = mockPosthogInit.mock.calls[0][1]
    expect(firstOptions).toMatchObject({
      persistence_name: 'thunderbolt_device_usage_v1_test-key',
      person_profiles: 'never',
      opt_out_capturing_by_default: true,
      ip: false,
      save_campaign_params: false,
      save_referrer: false,
      advanced_disable_flags: true,
    })
    // Consent retains its existing SDK key; changing analytics identity must not create a new opt-in.
    expect(firstOptions).not.toHaveProperty('consent_persistence_name')
    expect(mockOptIn).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('thunderbolt_pending_anon_id')).toBeNull()

    resetPosthogClient()
    await initPosthog(createMockHttpClient('test-key'))
    expect(mockPosthogInit.mock.calls[1][1]).toMatchObject({
      persistence_name: 'thunderbolt_device_usage_v1_test-key',
      opt_out_capturing_by_default: true,
    })
    expect(mockOptIn).not.toHaveBeenCalled()
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

    const result = capturedOptions!.before_send(event)!
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

    const result = capturedOptions!.before_send(event)!
    expect(result.properties.$current_url).toBe('https://app/chats/:chatThreadId')
    expect(result.properties.$referrer).toBe('https://referrer.test/chats/:chatThreadId')
  })

  it('removes project and mini-app IDs from page events and SDK session metadata', async () => {
    await initPosthog(createMockHttpClient())
    const event: PosthogEvent = {
      event: '$pageview',
      properties: {
        $current_url: 'https://app.test/projects/private-project',
        $pathname: '/projects/private-project',
        $session_entry_url: 'https://app.test/apps/private-app',
        $session_entry_pathname: '/apps/private-app',
      },
    }
    expect(capturedOptions!.before_send(event)?.properties).toEqual({
      $current_url: 'https://app.test/projects/:projectId',
      $pathname: '/projects/:projectId',
      $session_entry_url: 'https://app.test/apps/:appId',
      $session_entry_pathname: '/apps/:appId',
    })
  })

  it('removes callback nonces from SDK session-entry and nested initial person properties', async () => {
    await initPosthog(createMockHttpClient('test-key'))
    const callback = 'https://app.test/oauth/openrouter/private-nonce?code=private-code&state=private-state'
    const event: PosthogEvent = {
      event: 'app_init_timing',
      properties: {
        $session_entry_url: callback,
        $session_entry_pathname: '/oauth/openrouter/private-nonce',
        $session_entry_referrer: callback,
        $set_once: {
          $initial_current_url: callback,
          $initial_pathname: '/oauth/openrouter/private-nonce',
          $initial_referrer: callback,
        },
        $set: { $current_url: callback },
      },
    }
    const result = capturedOptions!.before_send(event)!
    expect(result.properties.$session_entry_url).toBe('https://app.test/oauth/openrouter/:flowId')
    expect(result.properties.$session_entry_pathname).toBe('/oauth/openrouter/:flowId')
    expect(result.properties.$set_once).toEqual({
      $initial_current_url: 'https://app.test/oauth/openrouter/:flowId',
      $initial_pathname: '/oauth/openrouter/:flowId',
      $initial_referrer: 'https://app.test/oauth/openrouter/:flowId',
    })
    expect(result.properties.$set).toEqual({ $current_url: 'https://app.test/oauth/openrouter/:flowId' })
    expect(JSON.stringify(result)).not.toContain('private-')
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

    const result = capturedOptions!.before_send(event)!
    expect(result.properties.$current_url).toBe(123)
    expect(result.properties.url).toEqual({ href: '/chats/1' })
    expect(result.properties.$pathname).toBeNull()
  })

  it('removes credentials and account-linked identifiers recursively while preserving metrics and SDK device identity', async () => {
    await initPosthog(createMockHttpClient())
    const event: PosthogEvent = {
      event: 'chat_turn_completed',
      properties: {
        distinct_id: 'sdk-random-device',
        $device_id: 'sdk-random-device',
        $session_id: 'sdk-random-session',
        user_id: 'private-user',
        accountId: 'private-account',
        $email: 'private@example.com',
        model_name: 'private-fine-tune-account',
        model_id: 'private-model',
        moved_task_id: 'private-task',
        trace_id: 'private-inference-receipt',
        nested: [{ api_key: 'private-key', chatId: 'private-chat', skill_id: 'private-skill', count: 2 }],
        $set: { $user_id: 'private-user', name: 'Private User' },
        error: 'Private response',
        total_ms: 100,
      },
    }
    expect(capturedOptions!.before_send(event)?.properties).toEqual({
      distinct_id: 'sdk-random-device',
      $device_id: 'sdk-random-device',
      $session_id: 'sdk-random-session',
      nested: [{ count: 2 }],
      $set: {},
      total_ms: 100,
    })
  })

  it('does not forward identity-linking events', async () => {
    await initPosthog(createMockHttpClient())
    for (const event of ['$identify', '$create_alias']) {
      expect(capturedOptions!.before_send({ event, properties: { distinct_id: 'account-id' } })).toBeNull()
    }
  })

  it('accepts absent properties and nested primitive arrays', () => {
    expect(() => stripPrivateAnalyticsProperties(undefined)).not.toThrow()
    const properties: Record<string, unknown> = { counts: [1, 2, null], nested: [{ apiKey: 'secret', count: 3 }] }
    stripPrivateAnalyticsProperties(properties)
    expect(properties).toEqual({ counts: [1, 2, null], nested: [{ count: 3 }] })
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

    expect(mockCaptureException).toHaveBeenCalledWith(error.code, {
      $exception_type: 'DATABASE_INIT_FAILED',
    })
  })

  it('includes structured diagnostic context without forwarding the raw error', async () => {
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

    expect(mockCaptureException).toHaveBeenCalledWith(error.code, {
      $exception_type: 'MIGRATION_FAILED',
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

    expect(mockCaptureException).toHaveBeenCalledWith(error.code, {
      $exception_type: 'TRAY_INIT_FAILED',
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

    expect(mockCaptureException).toHaveBeenCalledWith(error.code, {
      $exception_type: 'APP_DIR_CREATION_FAILED',
    })
  })
})

describe('deferred startup telemetry', () => {
  beforeEach(async () => {
    resetPosthogClient()
    mockCapture.mockReset()
    mockPosthogInit.mockReset()
    useLocalSettingsStore.setState({ syncEnabled: false })
    await updateSettings(getDb(), { data_collection: true })
  })

  afterEach(() => {
    useLocalSettingsStore.setState({ syncEnabled: false })
  })

  it('preserves early startup times and flushes them only once when analytics attaches', async () => {
    trackEvent('app_chat_ready', { chat_ready_ms: 123 })
    trackEvent('app_content_ready', { content_ready_ms: 150 })
    trackEvent('chat_send_prompt', { ignored: true })
    expect(mockCapture).not.toHaveBeenCalled()
    await initPosthog(createMockHttpClient())
    expect(mockCapture).toHaveBeenCalledWith('app_chat_ready', { chat_ready_ms: 123 })
    expect(mockCapture).toHaveBeenCalledWith('app_content_ready', { content_ready_ms: 150 })
    expect(mockCapture).toHaveBeenCalledTimes(2)
    await initPosthog(createMockHttpClient())
    expect(mockCapture).toHaveBeenCalledTimes(2)
  })

  it('does not send buffered events without an analytics key', async () => {
    trackEvent('app_chat_ready', { chat_ready_ms: 123 })
    await initPosthog(createMockHttpClient(''))
    expect(mockCapture).not.toHaveBeenCalled()
  })

  it('uses the latest consent when it changes while analytics configuration is pending', async () => {
    await updateSettings(getDb(), { data_collection: true })
    trackEvent('app_content_ready', { content_ready_ms: 150 })
    const response = Promise.withResolvers<Response>()
    const client = createClient({ prefixUrl: 'http://test-api.local', fetch: async () => await response.promise })
    const initializing = initPosthog(client)
    expect(mockPosthogInit).not.toHaveBeenCalled()

    await updateSettings(getDb(), { data_collection: false })
    response.resolve(Response.json({ public_posthog_api_key: 'test-key' }))
    await initializing
    expect(capturedOptions?.opt_out_capturing_by_default).toBe(true)
    expect(mockOptOut).toHaveBeenCalledTimes(1)
    expect(mockCapture).not.toHaveBeenCalled()
  })

  it('overrides a stored SDK opt-in when app consent is false before flushing startup events', async () => {
    await updateSettings(getDb(), { data_collection: false })
    trackEvent('app_content_ready', { content_ready_ms: 150 })

    expect((await initPosthog(createMockHttpClient())).success).toBe(true)
    expect(mockOptOut).toHaveBeenCalledTimes(1)
    expect(sdkOptedOut).toBe(true)
    expect(mockCapture).not.toHaveBeenCalled()
  })

  it('discards buffered startup events while synced consent is still unknown', async () => {
    useLocalSettingsStore.setState({ syncEnabled: true })
    trackEvent('app_content_ready', { content_ready_ms: 150 })

    expect((await initPosthog(createMockHttpClient())).success).toBe(true)
    expect(capturedOptions?.opt_out_capturing_by_default).toBe(true)
    expect(mockOptOut).toHaveBeenCalledTimes(1)
    expect(mockCapture).not.toHaveBeenCalled()

    useLocalSettingsStore.setState({ syncEnabled: false })
    await initPosthog(createMockHttpClient())
    expect(sdkOptedOut).toBe(false)
    expect(mockCapture).not.toHaveBeenCalled()
  })

  it('applies synced app consent over a stored SDK denial before flushing startup events', async () => {
    sdkOptedOut = true
    trackEvent('app_content_ready', { content_ready_ms: 150 })

    expect((await initPosthog(createMockHttpClient())).success).toBe(true)
    expect(mockOptIn).toHaveBeenCalledWith({ captureEventName: false })
    expect(sdkOptedOut).toBe(false)
    expect(mockCapture).toHaveBeenCalledWith('app_content_ready', { content_ready_ms: 150 })
  })
})
