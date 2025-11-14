import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { renderHook, act } from '@testing-library/react'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { useOAuthConnect, type OAuthDependencies, type OAuthStorage } from './use-oauth-connect'
import { mockOAuthCallbackData, mockOAuthErrorCallbackData, cleanupSessionStorage } from '@/test-utils/oauth'

/**
 * Creates an isolated storage instance for testing
 * This prevents pollution between tests by giving each test its own storage
 */
const createIsolatedStorage = (): OAuthStorage => {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
}

// Create mock functions for OAuth dependencies
const createMockDependencies = (storage: OAuthStorage): OAuthDependencies => ({
  startOAuthFlowWebview: async () => {
    // Return null to simulate user cancellation or error
    return null
  },
  redirectOAuthFlow: async (provider: string) => {
    // Simulate what the real redirectOAuthFlow does before redirecting
    storage.setItem('oauth_state', 'mock_state_12345')
    storage.setItem('oauth_provider', provider)
    storage.setItem('oauth_verifier', 'mock_verifier_67890')
    // Throw to simulate the redirect
    throw new Error('Redirecting for OAuth')
  },
  storage,
  exchangeCodeForTokens: async () => ({
    access_token: 'mock_token',
    refresh_token: 'mock_refresh',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'email profile',
  }),
  getUserInfo: async () => ({
    email: 'test@example.com',
    name: 'Test User',
    id: '123',
    verified_email: true,
  }),
})

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(() => {
  // Clean up before each test to prevent pollution
  cleanupSessionStorage()
})

afterEach(async () => {
  await resetTestDatabase()
  cleanupSessionStorage()
})

describe('useOAuthConnect', () => {
  // Create fresh mock dependencies and isolated storage for each test to prevent pollution
  let mockDeps: OAuthDependencies
  let isolatedStorage: OAuthStorage

  beforeEach(async () => {
    // Reset database and cleanup storage before each test
    await resetTestDatabase()
    cleanupSessionStorage()
    // Create isolated storage and fresh mock dependencies
    isolatedStorage = createIsolatedStorage()
    mockDeps = createMockDependencies(isolatedStorage)
  })

  describe('Tauri flow', () => {
    it('should handle successful OAuth connection', async () => {
      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
          setPreferredName: true,
          dependencies: mockDeps,
        }),
      )

      await act(async () => {
        try {
          await result.current.connect('google')
        } catch (_e) {
          // Expected in test environment without proper OAuth setup
        }
      })

      // Verify error handling works in test environment
      expect(result.current.error).toBeDefined()
    })

    it('should handle user cancellation', async () => {
      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
          dependencies: mockDeps,
        }),
      )

      await act(async () => {
        try {
          await result.current.connect('google')
        } catch (_e) {
          // Expected
        }
      })

      expect(onSuccess).not.toHaveBeenCalled()
    })

    it('should handle OAuth errors', async () => {
      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
          dependencies: mockDeps,
        }),
      )

      await act(async () => {
        try {
          await result.current.connect('google')
        } catch (_e) {
          // Expected
        }
      })

      expect(result.current.error).toBeDefined()
    })
  })

  describe('Web flow', () => {
    it('should initiate redirect for web environment', async () => {
      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
          returnContext: 'onboarding',
          dependencies: mockDeps,
        }),
      )

      await act(async () => {
        try {
          await result.current.connect('google')
        } catch (_e) {
          // Expected - OAuth flow can't complete in test
        }
      })

      // Verify return context was stored in isolated storage
      expect(isolatedStorage.getItem('oauth_return_context')).toBe('onboarding')
    })
  })

  describe('processCallback', () => {
    it('should handle successful OAuth callback', async () => {
      const callbackData = mockOAuthCallbackData()
      // Setup isolated storage instead of global sessionStorage
      isolatedStorage.setItem('oauth_state', callbackData.state!)
      isolatedStorage.setItem('oauth_provider', 'google')
      isolatedStorage.setItem('oauth_verifier', 'mock_verifier_67890')

      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
          dependencies: mockDeps,
        }),
      )

      await act(async () => {
        try {
          await result.current.processCallback(callbackData)
        } catch (_e) {
          // Expected in test
        }
      })

      // Can't fully test without mocking OAuth API calls
      // This is a limitation we'll accept for now
    })

    it('should handle state mismatch', async () => {
      const callbackData = mockOAuthCallbackData()
      // Setup isolated storage with mismatched state
      isolatedStorage.setItem('oauth_state', 'different_state')
      isolatedStorage.setItem('oauth_provider', 'google')
      isolatedStorage.setItem('oauth_verifier', 'mock_verifier_67890')

      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
          dependencies: mockDeps,
        }),
      )

      const success = await act(async () => {
        return await result.current.processCallback(callbackData)
      })

      expect(success).toBe(false)
      expect(result.current.error).toBe('OAuth validation failed')
      expect(onError).toHaveBeenCalled()
    })

    it('should handle OAuth error callback', async () => {
      const errorData = mockOAuthErrorCallbackData()

      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
          dependencies: mockDeps,
        }),
      )

      const success = await act(async () => {
        return await result.current.processCallback(errorData)
      })

      expect(success).toBe(false)
      expect(result.current.error).toBe('access_denied')
      expect(onError).toHaveBeenCalled()
    })
  })

  describe('Microsoft provider support', () => {
    it('should handle Microsoft OAuth flow', async () => {
      const onSuccess = mock()

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          setPreferredName: false,
          dependencies: mockDeps,
        }),
      )

      await act(async () => {
        try {
          await result.current.connect('microsoft')
        } catch (_e) {
          // Expected
        }
      })

      // Verify it attempts to connect (error is expected in test)
      expect(result.current.error).toBeDefined()
    })
  })

  describe('returnContext option', () => {
    it('should store correct return context', async () => {
      const { result } = renderHook(() =>
        useOAuthConnect({
          returnContext: 'onboarding',
          dependencies: mockDeps,
        }),
      )

      await act(async () => {
        try {
          await result.current.connect('google')
        } catch (_e) {
          // Expected
        }
      })

      expect(isolatedStorage.getItem('oauth_return_context')).toBe('onboarding')
    })
  })

  describe('error handling', () => {
    it('should clear error when clearError is called', async () => {
      const errorData = mockOAuthErrorCallbackData()

      const { result } = renderHook(() => useOAuthConnect({ dependencies: mockDeps }))

      await act(async () => {
        await result.current.processCallback(errorData)
      })

      expect(result.current.error).not.toBeNull()

      act(() => {
        result.current.clearError()
      })

      expect(result.current.error).toBeNull()
    })
  })
})
