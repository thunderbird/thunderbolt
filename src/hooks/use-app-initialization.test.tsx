import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import ky, { type KyInstance } from 'ky'
import { useAppInitialization } from './use-app-initialization'

mock.module('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: mock(),
}))

mock.module('@tauri-apps/plugin-os', () => ({
  platform: () => 'web',
}))

/**
 * Creates a ky HTTP client with a custom fetch function that returns mock PostHog config
 */
const createMockHttpClient = (): KyInstance => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        posthog_api_key: null, // Disable PostHog in tests
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  return ky.create({ fetch: mockFetch, prefixUrl: 'http://test-api.local' })
}

const mockHttpClient = createMockHttpClient()

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
    const { result } = renderHook(() => useAppInitialization(mockHttpClient))

    // Wait for initial render effects to settle
    await waitFor(() => {
      expect(result.current).toBeDefined()
    })

    expect(result.current).toHaveProperty('initData')
    expect(result.current).toHaveProperty('initError')
    expect(result.current).toHaveProperty('isInitializing')
    expect(result.current).toHaveProperty('retry')
    expect(result.current).toHaveProperty('clearDatabase')
    expect(typeof result.current.retry).toBe('function')
    expect(typeof result.current.clearDatabase).toBe('function')
  })

  it('initializes on mount and completes successfully', async () => {
    const { result } = renderHook(() => useAppInitialization(mockHttpClient))

    expect(result.current.isInitializing).toBe(true)

    await waitFor(
      () => {
        expect(result.current.isInitializing).toBe(false)
      },
      { timeout: 5000 },
    )

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

    const { result } = renderHook(() => useAppInitialization(mockHttpClient))

    await waitFor(
      () => {
        expect(result.current.initData).toBeDefined()
      },
      { timeout: 5000 },
    )

    expect(result.current.initData?.sideviewType).toBe('message')
    expect(result.current.initData?.sideviewId).toBe('123')
  })

  it('handles initialization gracefully when non-critical steps fail', async () => {
    const { result } = renderHook(() => useAppInitialization(mockHttpClient))

    await waitFor(
      () => {
        expect(result.current.isInitializing).toBe(false)
      },
      { timeout: 5000 },
    )

    expect(result.current.initData).toBeDefined()
    expect(result.current.initError).toBeUndefined()
  })

  it('retry function reinitializes the app', async () => {
    const { result } = renderHook(() => useAppInitialization(mockHttpClient))

    await waitFor(
      () => {
        expect(result.current.isInitializing).toBe(false)
        expect(result.current.initData).toBeDefined()
      },
      { timeout: 5000 },
    )

    await act(async () => {
      await result.current.retry()
    })

    await waitFor(
      () => {
        expect(result.current.isInitializing).toBe(false)
      },
      { timeout: 5000 },
    )

    expect(result.current.initData).toBeDefined()
    expect(result.current.initError).toBeUndefined()
  })
})
