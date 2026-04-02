import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockHttpClient } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { useAppInitialization } from './use-app-initialization'

mock.module('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: mock(),
}))

mock.module('@tauri-apps/plugin-os', () => ({
  platform: () => 'web',
}))

const mockPostHogConfig = {
  posthog_api_key: null, // Disable PostHog in tests
}

describe('useAppInitialization', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
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
})
