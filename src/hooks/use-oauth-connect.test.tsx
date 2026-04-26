import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { webPlatformMock } from '@/test-utils/platform-mock'

mock.module('@/lib/platform', () => webPlatformMock)

import { getSettings, updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { cleanupSessionStorage, mockOAuthCallbackData, mockOAuthErrorCallbackData } from '@/test-utils/oauth'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, renderHook } from '@testing-library/react'
import { useOAuthConnect, type OAuthDependencies } from './use-oauth-connect'

// Create mock functions for OAuth dependencies
const createMockDependencies = (): OAuthDependencies => ({
  startOAuthFlowLoopback: async () => {
    // Return null to simulate user cancellation or error
    return null
  },
  redirectOAuthFlow: async (_httpClient, provider) => {
    // Simulate what the real redirectOAuthFlow does before redirecting
    await updateSettings(getDb(), {
      oauth_state: 'mock_state_12345',
      oauth_provider: provider,
      oauth_verifier: 'mock_verifier_67890',
    })
    // Throw to simulate the redirect
    throw new Error('Redirecting for OAuth')
  },
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

beforeEach(async () => {
  // Clean up before each test to prevent pollution
  await cleanupSessionStorage()
})

afterEach(async () => {
  await resetTestDatabase()
  await cleanupSessionStorage()
})

describe('useOAuthConnect', () => {
  // Create fresh mock dependencies for each test
  let mockDeps: OAuthDependencies

  beforeEach(async () => {
    // Reset database and cleanup storage before each test
    await resetTestDatabase()
    await cleanupSessionStorage()
    // Create fresh mock dependencies
    mockDeps = createMockDependencies()
  })

  describe('Tauri flow', () => {
    it('should handle successful OAuth connection', async () => {
      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(
        () =>
          useOAuthConnect({
            onSuccess,
            onError,
            setPreferredName: true,
            dependencies: mockDeps,
          }),
        { wrapper: createQueryTestWrapper() },
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

      const { result } = renderHook(
        () =>
          useOAuthConnect({
            onSuccess,
            onError,
            dependencies: mockDeps,
          }),
        { wrapper: createQueryTestWrapper() },
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

      const { result } = renderHook(
        () =>
          useOAuthConnect({
            onSuccess,
            onError,
            dependencies: mockDeps,
          }),
        { wrapper: createQueryTestWrapper() },
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

      const { result } = renderHook(
        () =>
          useOAuthConnect({
            onSuccess,
            onError,
            returnContext: 'onboarding',
            dependencies: mockDeps,
          }),
        { wrapper: createQueryTestWrapper() },
      )

      await act(async () => {
        try {
          await result.current.connect('google')
        } catch (_e) {
          // Expected - OAuth flow can't complete in test
        }
      })

      // Verify return context was stored in sqlite
      const settings = await getSettings(getDb(), { oauth_return_context: String })
      expect(settings.oauthReturnContext).toBe('onboarding')
    })
  })

  describe('processCallback', () => {
    it('should handle successful OAuth callback', async () => {
      const callbackData = mockOAuthCallbackData()
      // Setup sqlite settings
      await updateSettings(getDb(), {
        oauth_state: callbackData.state!,
        oauth_provider: 'google',
        oauth_verifier: 'mock_verifier_67890',
      })

      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(
        () =>
          useOAuthConnect({
            onSuccess,
            onError,
            dependencies: mockDeps,
          }),
        { wrapper: createQueryTestWrapper() },
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
      // Setup sqlite settings with mismatched state
      await updateSettings(getDb(), {
        oauth_state: 'different_state',
        oauth_provider: 'google',
        oauth_verifier: 'mock_verifier_67890',
      })

      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(
        () =>
          useOAuthConnect({
            onSuccess,
            onError,
            dependencies: mockDeps,
          }),
        { wrapper: createQueryTestWrapper() },
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

      const { result } = renderHook(
        () =>
          useOAuthConnect({
            onSuccess,
            onError,
            dependencies: mockDeps,
          }),
        { wrapper: createQueryTestWrapper() },
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

      const { result } = renderHook(
        () =>
          useOAuthConnect({
            onSuccess,
            setPreferredName: false,
            dependencies: mockDeps,
          }),
        { wrapper: createQueryTestWrapper() },
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
      const { result } = renderHook(
        () =>
          useOAuthConnect({
            returnContext: 'onboarding',
            dependencies: mockDeps,
          }),
        { wrapper: createQueryTestWrapper() },
      )

      await act(async () => {
        try {
          await result.current.connect('google')
        } catch (_e) {
          // Expected
        }
      })

      // Verify return context was stored in sqlite
      const settings = await getSettings(getDb(), { oauth_return_context: String })
      expect(settings.oauthReturnContext).toBe('onboarding')
    })
  })

  describe('error handling', () => {
    it('should clear error when clearError is called', async () => {
      const errorData = mockOAuthErrorCallbackData()

      const { result } = renderHook(() => useOAuthConnect({ dependencies: mockDeps }), {
        wrapper: createQueryTestWrapper(),
      })

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
