/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { InitialSyncOutcome } from '@/db/database-interface'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { updateSettings } from '@/dal/settings'
import { getCurrentDatabase, getDb, setDatabase } from '@/db/database'
import { getInitTimingPayload, resetInitTiming } from '@/lib/init-timing'
import { createMockHttpClient } from '@/test-utils/http-client'
import { createClient } from '@/lib/http'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, mock, spyOn, test } from 'bun:test'
import { resolveInitialSyncStep, useAppInitialization, waitForDatabaseReady } from './use-app-initialization'

mock.module('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: mock(),
}))

mock.module('@tauri-apps/plugin-os', () => ({
  platform: () => 'web',
}))

const mockPostHogConfig = {
  public_posthog_api_key: null, // Disable PostHog in tests
}

/** Leaves analytics responses pending so tests can exercise the interactive app before they settle. */
const createPendingAnalyticsClient = () => {
  const responses: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const client = createClient({
    prefixUrl: 'http://test-api.local',
    fetch: async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.endsWith('/posthog/config')) {
        return Response.json({})
      }
      const response = Promise.withResolvers<Response>()
      responses.push(response)
      return await response.promise
    },
  })
  return { client, responses }
}

// happydom has no IndexedDB, so the boot pipeline's storage pre-flight
// (isIndexedDbAvailable) would short-circuit to STORAGE_UNAVAILABLE. Stub a
// working factory so the success path is exercised, mirroring a real browser.
const realIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')

const stubWorkingIndexedDb = (): void => {
  const factory = {
    open: () => {
      const request = {
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
        onblocked: null as (() => void) | null,
        result: { close: () => {} },
      }
      queueMicrotask(() => request.onsuccess?.())
      return request
    },
    deleteDatabase: () => ({}),
  } as unknown as IDBFactory
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true, writable: true })
}

describe('useAppInitialization', () => {
  beforeAll(async () => {
    stubWorkingIndexedDb()
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
    if (!realIndexedDb) {
      Reflect.deleteProperty(globalThis, 'indexedDB')
      return
    }
    Object.defineProperty(globalThis, 'indexedDB', realIndexedDb)
  })

  it('provides correct hook interface', async () => {
    const mockHttpClient = createMockHttpClient(mockPostHogConfig)
    const { result } = renderHook(() => useAppInitialization(mockHttpClient), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })

    // Advance timers to complete initialization
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(result.current).toBeDefined()
    expect(result.current).toHaveProperty('initData')
    expect(result.current).toHaveProperty('initError')
    expect(result.current).toHaveProperty('isInitializing')
    expect(result.current).toHaveProperty('retry')
    expect(result.current).toHaveProperty('clearDatabase')
    expect(typeof result.current.retry).toBe('function')
    expect(typeof result.current.clearDatabase).toBe('function')
  })

  it('initializes on mount and completes successfully', async () => {
    const mockHttpClient = createMockHttpClient(mockPostHogConfig)
    const { result } = renderHook(() => useAppInitialization(mockHttpClient), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })

    expect(result.current.isInitializing).toBe(true)

    // Advance timers to complete initialization
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(result.current.isInitializing).toBe(false)
    expect(result.current.initData).toBeDefined()
    expect(result.current.initError).toBeUndefined()
  })

  it('releases core content while analytics is still pending', async () => {
    const { client, responses } = createPendingAnalyticsClient()
    const { result } = renderHook(() => useAppInitialization(client), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(responses).toHaveLength(1)
    expect(result.current.isInitializing).toBe(false)
    expect(result.current.initData?.db).toBeDefined()
    expect(result.current.initData?.posthogClient).toBeNull()
    expect(result.current.initError).toBeUndefined()
    await act(async () => {
      responses[0].resolve(Response.json(mockPostHogConfig))
      await getClock().runAllAsync()
    })
    expect(result.current.initData?.db).toBeDefined()
  })

  it('ignores a late analytics completion from the previous initialization after retry', async () => {
    const { client, responses } = createPendingAnalyticsClient()
    const { result } = renderHook(() => useAppInitialization(client), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(responses).toHaveLength(1)
    const firstInitData = result.current.initData

    await act(async () => {
      await result.current.retry()
      await getClock().runAllAsync()
    })
    expect(responses).toHaveLength(2)
    const currentInitData = result.current.initData
    expect(currentInitData).toBeDefined()
    expect(currentInitData).not.toBe(firstInitData)
    expect(getInitTimingPayload()).not.toHaveProperty('step8_initialize_posthog_ms')

    await act(async () => {
      responses[0].resolve(Response.json(mockPostHogConfig))
      await getClock().runAllAsync()
    })
    // Publishing the obsolete service result would replace this object and
    // notify the current app tree even though that result belongs to run one.
    expect(result.current.initData).toBe(currentInitData)
    expect(result.current.isInitializing).toBe(false)
    expect(getInitTimingPayload()).not.toHaveProperty('step8_initialize_posthog_ms')

    await act(async () => {
      responses[1].resolve(Response.json(mockPostHogConfig))
      await getClock().runAllAsync()
    })
    expect(result.current.initData).not.toBe(currentInitData)
    expect(result.current.initData?.db).toBe(currentInitData?.db)
    expect(getInitTimingPayload().step8_initialize_posthog_ms).toBeNumber()
  })

  it('does not start deferred analytics when initialization completes after unmount', async () => {
    const { client, responses } = createPendingAnalyticsClient()
    const { unmount } = renderHook(() => useAppInitialization(client), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })
    unmount()
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(responses).toHaveLength(0)
  })

  it('keeps core content available when deferred analytics fails', async () => {
    const { client, responses } = createPendingAnalyticsClient()
    const { result } = renderHook(() => useAppInitialization(client), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(responses).toHaveLength(1)
    const database = result.current.initData?.db

    await act(async () => {
      responses[0].resolve(Response.json({}, { status: 403 }))
      await getClock().runAllAsync()
    })
    expect(result.current.isInitializing).toBe(false)
    expect(result.current.initData?.db).toBe(database)
    expect(result.current.initData?.posthogClient).toBeNull()
    expect(result.current.initError).toBeUndefined()
  })

  it('does not replace a successful retry with an earlier database-reset failure', async () => {
    const database = getCurrentDatabase()!
    const closing = Promise.withResolvers<void>()
    const close = spyOn(database, 'close').mockImplementation(() => closing.promise)
    const client = createMockHttpClient(mockPostHogConfig)
    const { result, unmount } = renderHook(() => useAppInitialization(client), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })
    try {
      await act(async () => {
        await getClock().runAllAsync()
      })
      let clearing: Promise<void> = Promise.resolve()
      act(() => {
        clearing = result.current.clearDatabase()
      })
      expect(close).toHaveBeenCalledTimes(1)
      expect(result.current.isInitializing).toBe(true)

      await act(async () => {
        await result.current.retry()
      })
      const currentInitData = result.current.initData
      expect(currentInitData).toBeDefined()

      await act(async () => {
        closing.reject(new Error('Database close failed'))
        await clearing
      })
      expect(result.current.initData).toBe(currentInitData)
      expect(result.current.initError).toBeUndefined()
      expect(result.current.isInitializing).toBe(false)
    } finally {
      unmount()
      close.mockRestore()
    }
  })

  it('does not restart initialization when a database reset finishes after unmount', async () => {
    const database = getCurrentDatabase()!
    const closing = Promise.withResolvers<void>()
    const close = spyOn(database, 'close').mockImplementation(() => closing.promise)
    const client = createMockHttpClient(mockPostHogConfig)
    const { result, unmount } = renderHook(() => useAppInitialization(client), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })
    try {
      await act(async () => {
        await getClock().runAllAsync()
      })
      let clearing: Promise<void> = Promise.resolve()
      act(() => {
        clearing = result.current.clearDatabase()
      })
      const initRun = getInitTimingPayload().init_run
      unmount()

      await act(async () => {
        closing.resolve()
        await clearing
        await getClock().runAllAsync()
      })
      expect(getInitTimingPayload().init_run).toBe(initRun)
    } finally {
      close.mockRestore()
      // The fake close keeps the test database open, while resetDatabase clears its registration.
      setDatabase(database)
    }
  })

  it('retry function reinitializes the app', async () => {
    const mockHttpClient = createMockHttpClient(mockPostHogConfig)
    const { result } = renderHook(() => useAppInitialization(mockHttpClient), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })

    // Advance timers to complete initialization
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(result.current.isInitializing).toBe(false)
    expect(result.current.initData).toBeDefined()

    await act(async () => {
      await result.current.retry()
      await getClock().runAllAsync()
    })

    expect(result.current.isInitializing).toBe(false)
    expect(result.current.initData).toBeDefined()
    expect(result.current.initError).toBeUndefined()
  })

  it.each([false, true])('provides the persisted sidebar preference (%s) before the layout mounts', async (open) => {
    await updateSettings(getDb(), { sidebar_state: open })
    const client = createMockHttpClient(mockPostHogConfig)
    const { result } = renderHook(() => useAppInitialization(client), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(result.current.initData?.sidebarOpen).toBe(open)
  })

  it('records every init step duration for the app_init_timing payload', async () => {
    resetInitTiming()
    const mockHttpClient = createMockHttpClient(mockPostHogConfig)
    const { result } = renderHook(() => useAppInitialization(mockHttpClient), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(result.current.initData).toBeDefined()

    const payload = getInitTimingPayload()
    const expectedStepKeys = [
      'step0_fetch_config_ms',
      'step1_create_app_dir_ms',
      'step2_initialize_database_ms',
      'step2b_db_ready_ms',
      'step2c_returning_boot_probe_ms',
      'step3_wait_for_initial_sync_ms',
      'step4_reconcile_defaults_ms',
      'step4b_run_data_migrations_ms',
      'step5_get_settings_ms',
      'step7_initialize_tray_ms',
      'step8_initialize_posthog_ms',
    ]
    for (const key of expectedStepKeys) {
      expect(payload[key]).toBeNumber()
    }
    // step6 is skipped when an httpClient is injected (as in this test).
    expect(payload).not.toHaveProperty('step6_create_http_client_ms')
    expect(payload.init_run).toBeGreaterThanOrEqual(1)
  })
})

/**
 * Direct unit tests for the returning-boot branch (THU-677). The hook itself
 * is hard to observe here because `initial_sync_outcome` / `init_path` are
 * only visible through the PostHog `trackEvent` payload, and mocking that
 * shared module would violate the no-shared-mocks rule. Testing the
 * extracted branch keeps the observable surface small and honest.
 */
describe('resolveInitialSyncStep', () => {
  const makeGate = (outcome: InitialSyncOutcome) => ({
    waitForInitialSync: async () => outcome,
  })

  test('awaits waitForInitialSync when canSkipSyncWait=false and passes the outcome through', async () => {
    const { initialSyncOutcome, initialSyncCompleted } = await resolveInitialSyncStep(makeGate('synced'), false)
    expect(initialSyncOutcome).toBe('synced')
    expect(initialSyncCompleted).toBe(true)
  })

  test('flags initialSyncCompleted=true when outcome is disabled — sync-disabled devices still receive bundle updates', async () => {
    const { initialSyncOutcome, initialSyncCompleted } = await resolveInitialSyncStep(makeGate('disabled'), false)
    expect(initialSyncOutcome).toBe('disabled')
    expect(initialSyncCompleted).toBe(true)
  })

  test('flags initialSyncCompleted=false when outcome is timed_out or failed', async () => {
    for (const outcome of ['timed_out', 'failed'] as const) {
      const result = await resolveInitialSyncStep(makeGate(outcome), false)
      expect(result.initialSyncCompleted).toBe(false)
      expect(result.initialSyncOutcome).toBe(outcome)
    }
  })

  test('returns skipped_returning without awaiting waitForInitialSync when canSkipSyncWait=true', async () => {
    // Never-resolving promise: if the branch awaits it, the test hangs. The
    // outer resolveInitialSyncStep attaches a .catch handler so the leak is
    // silent — no unhandled rejection to worry about.
    let called = false
    const gate = {
      waitForInitialSync: () => {
        called = true
        return new Promise<InitialSyncOutcome>(() => {})
      },
    }
    const { initialSyncOutcome, initialSyncCompleted } = await resolveInitialSyncStep(gate, true)
    expect(called).toBe(true)
    expect(initialSyncOutcome).toBe('skipped_returning')
    expect(initialSyncCompleted).toBe(false)
  })
})

describe('waitForDatabaseReady', () => {
  it('reports ready when the first query resolves', async () => {
    const db = { get: mock(async () => ({ 1: 1 })) }
    expect(await waitForDatabaseReady(db as never, 1000)).toEqual({ outcome: 'ready' })
    expect(db.get).toHaveBeenCalledTimes(1)
  })

  it('reports failed with the original error when the first query rejects, rather than propagating', async () => {
    const queryError = new Error('no such vfs')
    const db = {
      get: mock(async () => {
        throw queryError
      }),
    }
    const result = await waitForDatabaseReady(db as never, 1000)
    expect(result).toEqual({ outcome: 'failed', error: queryError })
  })

  // The whole point: PowerSync opens storage lazily on this query, so a database
  // that never opens used to hang the boot spinner indefinitely.
  it('reports timed_out when the first query never settles', async () => {
    const db = { get: mock(() => new Promise(() => {})) }
    const pending = waitForDatabaseReady(db as never, 20)
    await getClock().runAllAsync()
    expect(await pending).toEqual({ outcome: 'timed_out' })
  })

  it('does not time out a slow-but-successful open', async () => {
    const db = { get: mock(() => new Promise((resolve) => setTimeout(() => resolve({ 1: 1 }), 30))) }
    const pending = waitForDatabaseReady(db as never, 2000)
    await getClock().runAllAsync()
    expect(await pending).toEqual({ outcome: 'ready' })
  })
})
