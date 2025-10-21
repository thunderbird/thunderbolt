import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { renderHook, act } from '@testing-library/react'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getSettings } from '@/dal/settings'
import { useOAuthConnect } from './use-oauth-connect'
import {
  mockOAuthSuccess,
  mockOAuthCallbackData,
  mockOAuthErrorCallbackData,
  setupSessionStorage,
  cleanupSessionStorage,
} from '@/test-utils/oauth'

// Mock external dependencies
const mockIsTauri = mock(() => true)
const mockStartOAuthFlowWebview = mock()
const mockRedirectOAuthFlow = mock()
const mockExchangeCodeForTokens = mock()
const mockGetUserInfo = mock()

// Mock modules
mock.module('@/lib/platform', () => ({
  isTauri: mockIsTauri,
}))

mock.module('@/lib/oauth-webview', () => ({
  startOAuthFlowWebview: mockStartOAuthFlowWebview,
}))

mock.module('@/lib/auth', () => ({
  redirectOAuthFlow: mockRedirectOAuthFlow,
  exchangeCodeForTokens: mockExchangeCodeForTokens,
  getUserInfo: mockGetUserInfo,
}))

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

afterEach(async () => {
  await resetTestDatabase()
  cleanupSessionStorage()

  // Reset all mocks
  mockIsTauri.mockClear()
  mockStartOAuthFlowWebview.mockClear()
  mockRedirectOAuthFlow.mockClear()
  mockExchangeCodeForTokens.mockClear()
  mockGetUserInfo.mockClear()
})

describe('useOAuthConnect', () => {
  describe('Tauri flow', () => {
    it('should handle successful OAuth connection', async () => {
      const mockSuccess = mockOAuthSuccess()
      const onSuccess = mock()
      const onError = mock()

      mockIsTauri.mockReturnValue(true)
      mockStartOAuthFlowWebview.mockResolvedValue(mockSuccess)

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
          setPreferredName: true,
          returnContext: 'onboarding',
        }),
      )

      await act(async () => {
        await result.current.connect('google')
      })

      // Verify OAuth flow was called
      expect(mockStartOAuthFlowWebview).toHaveBeenCalledWith('google')

      // Verify success callback
      expect(onSuccess).toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()

      // Verify credentials saved to database
      const credentials = await getSettings({
        integrations_google_credentials: String,
        integrations_google_is_enabled: false,
        preferred_name: String,
      })

      expect(credentials.integrationsGoogleCredentials).toContain('mock_access_token_12345')
      expect(credentials.integrationsGoogleIsEnabled).toBe(true)
      expect(credentials.preferredName).toBe('Test User')
    })

    it('should handle user cancellation', async () => {
      const onSuccess = mock()
      const onError = mock()

      mockIsTauri.mockReturnValue(true)
      mockStartOAuthFlowWebview.mockResolvedValue(null)

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
          setPreferredName: true,
        }),
      )

      await act(async () => {
        await result.current.connect('google')
      })

      // Verify OAuth flow was called
      expect(mockStartOAuthFlowWebview).toHaveBeenCalledWith('google')

      // Verify no callbacks were called
      expect(onSuccess).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()

      // Verify no credentials were saved
      const credentials = await getSettings({
        integrations_google_credentials: String,
        integrations_google_is_enabled: false,
      })

      expect(credentials.integrationsGoogleCredentials).toBe(null)
      expect(credentials.integrationsGoogleIsEnabled).toBe(false)
    })

    it('should handle OAuth errors', async () => {
      const onSuccess = mock()
      const onError = mock()
      const error = new Error('OAuth failed')

      mockIsTauri.mockReturnValue(true)
      mockStartOAuthFlowWebview.mockRejectedValue(error)

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
        }),
      )

      await act(async () => {
        await result.current.connect('google')
      })

      // Verify error callback
      expect(onError).toHaveBeenCalledWith(error)
      expect(onSuccess).not.toHaveBeenCalled()

      // Verify error state
      expect(result.current.error).toBe('OAuth failed')
    })
  })

  describe('Web flow', () => {
    it('should initiate redirect for web environment', async () => {
      const onSuccess = mock()
      const onError = mock()

      mockIsTauri.mockReturnValue(false)
      mockRedirectOAuthFlow.mockImplementation(() => {
        throw new Error('Redirecting for OAuth')
      })

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
          returnContext: 'integrations',
        }),
      )

      await act(async () => {
        try {
          await result.current.connect('google')
        } catch {
          // Expected to throw for redirect
        }
      })

      // Verify redirect was called
      expect(mockRedirectOAuthFlow).toHaveBeenCalledWith('google')

      // Verify session storage context
      expect(sessionStorage.getItem('oauth_return_context')).toBe('integrations')
    })
  })

  describe('processCallback', () => {
    it('should handle successful OAuth callback', async () => {
      const mockSuccess = mockOAuthSuccess()
      const callbackData = mockOAuthCallbackData()
      const sessionData = setupSessionStorage('google')

      mockExchangeCodeForTokens.mockResolvedValue(mockSuccess.tokens)
      mockGetUserInfo.mockResolvedValue(mockSuccess.userInfo)

      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
          setPreferredName: true,
        }),
      )

      const success = await act(async () => {
        return await result.current.processCallback(callbackData)
      })

      // Verify success
      expect(success).toBe(true)
      expect(onSuccess).toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()

      // Verify tokens were exchanged
      expect(mockExchangeCodeForTokens).toHaveBeenCalledWith('google', callbackData.code, sessionData.oauth_verifier)

      // Verify user info was fetched
      expect(mockGetUserInfo).toHaveBeenCalledWith('google', mockSuccess.tokens.access_token)

      // Verify credentials saved
      const credentials = await getSettings({
        integrations_google_credentials: String,
        integrations_google_is_enabled: false,
        preferred_name: String,
      })

      expect(credentials.integrationsGoogleCredentials).toContain('mock_access_token_12345')
      expect(credentials.integrationsGoogleIsEnabled).toBe(true)
      expect(credentials.preferredName).toBe('Test User')

      // Verify session storage cleaned up
      expect(sessionStorage.getItem('oauth_state')).toBe(null)
      expect(sessionStorage.getItem('oauth_provider')).toBe(null)
      expect(sessionStorage.getItem('oauth_verifier')).toBe(null)
      expect(sessionStorage.getItem('oauth_return_context')).toBe(null)
    })

    it('should handle state mismatch', async () => {
      const callbackData = mockOAuthCallbackData()
      setupSessionStorage('google')

      // Modify state to cause mismatch
      sessionStorage.setItem('oauth_state', 'different_state')

      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
        }),
      )

      const success = await act(async () => {
        return await result.current.processCallback(callbackData)
      })

      // Verify failure
      expect(success).toBe(false)
      expect(onSuccess).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(expect.any(Error))

      // Verify error state
      expect(result.current.error).toBe('OAuth validation failed')
    })

    it('should handle OAuth error callback', async () => {
      const errorData = mockOAuthErrorCallbackData()

      const onSuccess = mock()
      const onError = mock()

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          onError,
        }),
      )

      const success = await act(async () => {
        return await result.current.processCallback(errorData)
      })

      // Verify failure
      expect(success).toBe(false)
      expect(onSuccess).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(expect.any(Error))

      // Verify error state
      expect(result.current.error).toBe('access_denied')
    })
  })

  describe('Microsoft provider support', () => {
    it('should handle Microsoft OAuth flow', async () => {
      const mockSuccess = mockOAuthSuccess()
      const onSuccess = mock()

      mockIsTauri.mockReturnValue(true)
      mockStartOAuthFlowWebview.mockResolvedValue(mockSuccess)

      const { result } = renderHook(() =>
        useOAuthConnect({
          onSuccess,
          setPreferredName: true,
        }),
      )

      await act(async () => {
        await result.current.connect('microsoft')
      })

      // Verify Microsoft flow was called
      expect(mockStartOAuthFlowWebview).toHaveBeenCalledWith('microsoft')

      // Verify Microsoft credentials saved
      const credentials = await getSettings({
        integrations_microsoft_credentials: String,
        integrations_microsoft_is_enabled: false,
      })

      expect(credentials.integrationsMicrosoftCredentials).toContain('mock_access_token_12345')
      expect(credentials.integrationsMicrosoftIsEnabled).toBe(true)
    })
  })

  describe('returnContext option', () => {
    it('should store correct return context', async () => {
      mockIsTauri.mockReturnValue(false)
      mockRedirectOAuthFlow.mockImplementation(() => {
        throw new Error('Redirecting for OAuth')
      })

      const { result } = renderHook(() =>
        useOAuthConnect({
          returnContext: 'integrations',
        }),
      )

      await act(async () => {
        try {
          await result.current.connect('google')
        } catch {
          // Expected to throw for redirect
        }
      })

      // Verify correct context stored
      expect(sessionStorage.getItem('oauth_return_context')).toBe('integrations')
    })
  })

  describe('error handling', () => {
    it('should clear error when clearError is called', () => {
      const { result } = renderHook(() => useOAuthConnect())

      // Set an error
      act(() => {
        result.current.clearError()
      })

      expect(result.current.error).toBe(null)
    })
  })
})
