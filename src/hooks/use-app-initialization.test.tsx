/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { InitialSyncOutcome } from '@/db/database-interface'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getInitTimingPayload, resetInitTiming } from '@/lib/init-timing'
import { createMockHttpClient } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, mock, test } from 'bun:test'
import { resolveInitialSyncStep, useAppInitialization } from './use-app-initialization'

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

// happydom has no IndexedDB, so the boot pipeline's storage pre-flight
// (isIndexedDbAvailable) would short-circuit to STORAGE_UNAVAILABLE. Stub a
// working factory so the success path is exercised, mirroring a real browser.
const realIndexedDb = globalThis.indexedDB

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
    Object.defineProperty(globalThis, 'indexedDB', { value: realIndexedDb, configurable: true, writable: true })
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

  it('handles initialization gracefully when non-critical steps fail', async () => {
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
    expect(result.current.initError).toBeUndefined()
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
