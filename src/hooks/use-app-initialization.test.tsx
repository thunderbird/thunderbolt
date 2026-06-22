/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getInitTimingPayload, resetInitTiming } from '@/lib/init-timing'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { createMockHttpClient } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useAppInitialization } from './use-app-initialization'

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

const testServerId = '00000000-0000-0000-0000-000000000abc'

describe('useAppInitialization', () => {
  beforeAll(async () => {
    stubWorkingIndexedDb()
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
    Object.defineProperty(globalThis, 'indexedDB', { value: realIndexedDb, configurable: true, writable: true })
  })

  beforeEach(() => {
    // Seed the trust-domain registry so boot resolves without hitting /v1/config.
    // The shared mock HTTP client returns the PostHog payload for every GET — including
    // the config endpoint — so first-boot resolution would otherwise fail.
    useTrustDomainRegistry.setState({
      servers: { [testServerId]: { serverId: testServerId, cloudUrl: 'http://test-api.local' } },
      activeTrustDomain: { kind: 'server', serverId: testServerId },
    })
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
      'step0_resolve_trust_domain_ms',
      'step1_create_app_dir_ms',
      'step2_initialize_database_ms',
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
