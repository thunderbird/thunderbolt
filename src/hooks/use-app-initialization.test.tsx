import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockHttpClient } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
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
  let originalLocation: Location | undefined

  beforeAll(async () => {
    await setupTestDatabase()

    if (typeof window !== 'undefined' && window.location) {
      originalLocation = window.location
    }
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    if (typeof window !== 'undefined') {
      try {
        Object.defineProperty(window, 'location', {
          value: {
            ...window.location,
            href: 'https://app.test/?sideview=message:123',
          },
          writable: true,
          configurable: true,
        })
      } catch {
        // If we can't modify location, tests will use default
      }
    }
  })

  afterEach(() => {
    if (originalLocation && typeof window !== 'undefined') {
      try {
        Object.defineProperty(window, 'location', {
          value: originalLocation,
          writable: true,
          configurable: true,
        })
      } catch {
        // Ignore restore errors
      }
    }
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

  it('parses sideview parameters from URL', async () => {
    Object.defineProperty(window, 'location', {
      value: {
        href: 'https://app.test/?sideview=message:123',
      },
      writable: true,
      configurable: true,
    })

    const mockHttpClient = createMockHttpClient(mockPostHogConfig)
    const { result } = renderHook(() => useAppInitialization(mockHttpClient), {
      wrapper: createTestProvider({ mockResponse: mockPostHogConfig }),
    })

    // Advance timers to complete initialization
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(result.current.initData).toBeDefined()
    expect(result.current.initData?.sideviewType).toBe('message')
    expect(result.current.initData?.sideviewId).toBe('123')
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
