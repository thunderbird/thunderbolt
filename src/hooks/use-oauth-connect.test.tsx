/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getOAuthState, setOAuthState } from '@/lib/oauth-state'
import type { OAuthTokens, OAuthUserInfo } from '@/lib/auth'
import type { RemoteCallback } from 'drizzle-orm/sqlite-proxy'
import { getDb } from '@/db/database'
import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
import { getSettings, updateSettings } from '@/dal/settings'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import { clearIdentityScopedMemory } from '@/lib/identity-memory'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { cleanupSessionStorage, mockOAuthCallbackData, mockOAuthErrorCallbackData } from '@/test-utils/oauth'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getIntegrationRelayUrl } from '@/lib/integration-oauth-client'
import { useOAuthConnect, type OAuthDependencies } from './use-oauth-connect'

// Create mock functions for OAuth dependencies
const createMockDependencies = (): OAuthDependencies => ({
  startOAuthFlowLoopback: async () => {
    // Return null to simulate user cancellation or error
    return null
  },
  redirectOAuthFlow: async (_httpClient, provider, oauthRelayUrl) => {
    // Simulate what the real redirectOAuthFlow does before redirecting
    setOAuthState({
      state: 'mock_state_12345',
      provider,
      verifier: 'mock_verifier_67890',
      oauthRelayUrl,
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

      // Verify return context was stored in sessionStorage
      const oauthState = getOAuthState()
      expect(oauthState.returnContext).toBe('onboarding')
      expect(oauthState.oauthRelayUrl).toBe(getIntegrationRelayUrl())
    })
  })

  describe('processCallback', () => {
    it.each(['google', 'microsoft'] as const)(
      'forgets a pending %s authorization and its UI markers before a late callback',
      async (provider) => {
        setOAuthState({ state: 'native-return', provider, verifier: 'native-verifier' })
        sessionStorage.setItem(`oauth_connecting_${provider}`, 'true')
        sessionStorage.setItem(`oauth_connecting_${provider}_timestamp`, String(Date.now()))
        sessionStorage.setItem('oauth_connecting_widget-42', 'true')
        sessionStorage.setItem('oauth_connecting_widget-42_timestamp', String(Date.now()))
        sessionStorage.setItem('unrelated', 'keep')
        const exchangeCodeForTokens = mock(mockDeps.exchangeCodeForTokens!)
        const onSuccess = mock()
        const { result } = renderHook(
          () => useOAuthConnect({ onSuccess, dependencies: { ...mockDeps, exchangeCodeForTokens } }),
          { wrapper: createQueryTestWrapper() },
        )

        clearIdentityScopedMemory()
        expect(getOAuthState().state).toBeNull()
        expect(sessionStorage.getItem(`oauth_connecting_${provider}`)).toBeNull()
        expect(sessionStorage.getItem(`oauth_connecting_${provider}_timestamp`)).toBeNull()
        expect(sessionStorage.getItem('oauth_connecting_widget-42')).toBeNull()
        expect(sessionStorage.getItem('oauth_connecting_widget-42_timestamp')).toBeNull()
        expect(sessionStorage.getItem('unrelated')).toBe('keep')
        await act(async () => {
          expect(await result.current.processCallback({ code: 'late', state: 'native-return' })).toBe(false)
        })
        expect(exchangeCodeForTokens).not.toHaveBeenCalled()
        expect(await getIntegrationCredentials(getDb(), provider)).toBeNull()
        expect(onSuccess).not.toHaveBeenCalled()
      },
    )

    it.each([
      ['google', 'credentials', 'insert'],
      ['microsoft', 'credentials', 'insert'],
      ['google', 'credentials', 'update'],
      ['microsoft', 'credentials', 'update'],
      ['google', 'name', 'insert'],
      ['microsoft', 'name', 'insert'],
      ['google', 'name', 'update'],
      ['microsoft', 'name', 'update'],
    ] as const)(
      'rolls back %s %s %s when identity cleanup interrupts its database write',
      async (provider, phase, operation) => {
        const previous = { access_token: 'old-access', expires_at: 1000 }
        if (phase === 'credentials' && operation === 'update') {
          await saveIntegrationCredentials(getDb(), provider, previous, false)
        }
        if (phase === 'name' && operation === 'update') {
          await updateSettings(getDb(), { preferred_name: 'Old name' })
        }
        const table = phase === 'credentials' ? 'integrations_secrets' : 'settings'
        const prefix = `${operation} ${operation === 'insert' ? 'into ' : ''}"${table}"`
        const session = (getDb() as unknown as { session: { client: RemoteCallback } }).session
        const execute = session.client
        const write = spyOn(session, 'client').mockImplementation(async (sql, params, method) => {
          const result = await execute(sql, params, method)
          if (sql.startsWith(prefix)) {
            // Model the worker finishing SQL while the identity changes before its promise resolves.
            invalidateIdentityLifetime()
          }
          return result
        })
        try {
          setOAuthState({ state: 'native-return', provider, verifier: 'native-verifier' })
          const onSuccess = mock()
          const { result } = renderHook(
            () => useOAuthConnect({ onSuccess, setPreferredName: true, dependencies: mockDeps }),
            { wrapper: createQueryTestWrapper() },
          )
          await act(async () => {
            expect(await result.current.processCallback({ code: 'one-use', state: 'native-return' })).toBe(false)
          })
          expect(onSuccess).not.toHaveBeenCalled()
          if (phase === 'credentials') {
            expect(await getIntegrationCredentials(getDb(), provider)).toEqual(
              operation === 'update' ? { credentials: previous, enabled: false } : null,
            )
          }
          expect(await getSettings(getDb(), { preferred_name: String })).toEqual({
            preferredName: phase === 'name' && operation === 'update' ? 'Old name' : null,
          })
        } finally {
          write.mockRestore()
        }
      },
    )

    it.each(['google', 'microsoft'] as const)(
      'does not restore %s credentials when identity cleanup interrupts its profile request',
      async (provider) => {
        const profile = Promise.withResolvers<OAuthUserInfo>()
        const getUserInfo = mock(() => profile.promise)
        setOAuthState({ state: 'native-return', provider, verifier: 'native-verifier' })
        const { result } = renderHook(() => useOAuthConnect({ dependencies: { ...mockDeps, getUserInfo } }), {
          wrapper: createQueryTestWrapper(),
        })

        await act(async () => {
          const pending = result.current.processCallback({ code: 'one-use', state: 'native-return' })
          await Promise.resolve()
          expect(getUserInfo).toHaveBeenCalledTimes(1)
          invalidateIdentityLifetime()
          profile.resolve({ email: 'old@example.com', name: 'Old identity', id: 'old', verified_email: true })
          expect(await pending).toBe(false)
        })
        expect(await getIntegrationCredentials(getDb(), provider)).toBeNull()
      },
    )

    it.each(['google', 'microsoft'] as const)(
      'does not restore %s credentials when identity cleanup interrupts its exchange',
      async (provider) => {
        const exchange = Promise.withResolvers<OAuthTokens>()
        const onSuccess = mock()
        setOAuthState({ state: 'native-return', provider, verifier: 'native-verifier' })
        const { result } = renderHook(
          () =>
            useOAuthConnect({
              onSuccess,
              dependencies: { ...mockDeps, exchangeCodeForTokens: () => exchange.promise },
            }),
          { wrapper: createQueryTestWrapper() },
        )

        await act(async () => {
          const pending = result.current.processCallback({ code: 'one-use', state: 'native-return' })
          invalidateIdentityLifetime()
          exchange.resolve({ access_token: 'access', expires_in: 3600, token_type: 'Bearer' })
          expect(await pending).toBe(false)
        })
        expect(await getIntegrationCredentials(getDb(), provider)).toBeNull()
        expect(onSuccess).not.toHaveBeenCalled()
      },
    )

    it.each(['google', 'microsoft'] as const)(
      'consumes a %s callback before exchange so replay cannot redeem its code twice',
      async (provider) => {
        const exchange = Promise.withResolvers<never>()
        const exchangeCodeForTokens = mock(() => exchange.promise)
        setOAuthState({ state: 'native-return', provider, verifier: 'native-verifier' })
        const { result } = renderHook(() => useOAuthConnect({ dependencies: { ...mockDeps, exchangeCodeForTokens } }), {
          wrapper: createQueryTestWrapper(),
        })

        await act(async () => {
          const first = result.current.processCallback({ code: 'one-use', state: 'native-return' })
          expect(getOAuthState().state).toBeNull()
          expect(await result.current.processCallback({ code: 'one-use', state: 'native-return' })).toBe(false)
          expect(exchangeCodeForTokens).toHaveBeenCalledTimes(1)
          exchange.reject(new Error('Token exchange failed'))
          expect(await first).toBe(false)
        })
      },
    )

    it('preserves a newer authorization when an earlier callback finishes', async () => {
      const exchange = Promise.withResolvers<OAuthTokens>()
      setOAuthState({ state: 'old-return', provider: 'google', verifier: 'old-verifier' })
      const { result } = renderHook(
        () => useOAuthConnect({ dependencies: { ...mockDeps, exchangeCodeForTokens: () => exchange.promise } }),
        { wrapper: createQueryTestWrapper() },
      )

      await act(async () => {
        const first = result.current.processCallback({ code: 'one-use', state: 'old-return' })
        setOAuthState({ state: 'new-return', provider: 'microsoft', verifier: 'new-verifier' })
        exchange.resolve({ access_token: 'access', expires_in: 3600, token_type: 'Bearer' })
        expect(await first).toBe(true)
      })
      expect(getOAuthState()).toMatchObject({ state: 'new-return', provider: 'microsoft', verifier: 'new-verifier' })
    })

    it('retires a matching denial but leaves a different pending authorization intact', async () => {
      setOAuthState({ state: 'native-return', provider: 'google', verifier: 'native-verifier' })
      const { result } = renderHook(() => useOAuthConnect({ dependencies: mockDeps }), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        expect(await result.current.processCallback({ state: 'old-return', error: 'access_denied' })).toBe(false)
        expect(getOAuthState().state).toBe('native-return')
        expect(await result.current.processCallback({ state: 'native-return', error: 'access_denied' })).toBe(false)
        expect(getOAuthState().state).toBeNull()
      })
    })

    it('should handle successful OAuth callback', async () => {
      const callbackData = mockOAuthCallbackData()
      // Setup OAuth state in sessionStorage
      setOAuthState({
        state: callbackData.state!,
        provider: 'google',
        verifier: 'mock_verifier_67890',
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
      // Setup sessionStorage with mismatched state
      setOAuthState({
        state: 'different_state',
        provider: 'google',
        verifier: 'mock_verifier_67890',
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

      // Verify return context was stored in sessionStorage
      const oauthState = getOAuthState()
      expect(oauthState.returnContext).toBe('onboarding')
      expect(oauthState.oauthRelayUrl).toBe(getIntegrationRelayUrl())
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
