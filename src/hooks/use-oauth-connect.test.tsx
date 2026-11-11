/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { OAuthTokens, OAuthUserInfo } from '@/lib/auth'
import type { RemoteCallback } from 'drizzle-orm/sqlite-proxy'
import { saveIntegrationCredentials } from '@/dal/integrations'
import { getSettings, updateSettings } from '@/dal/settings'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import { clearIdentityScopedMemory } from '@/lib/identity-memory'
import { getIntegrationRelayUrl } from '@/lib/integration-oauth-client'
import { getIntegrationCredentials, getSettingsRecords } from '@/dal'
import { getDb } from '@/db/database'
import { getOAuthState, setOAuthState, clearOAuthState } from '@/lib/oauth-state'
import * as platform from '@/lib/platform'
import * as auth from '@/lib/auth'
import * as opener from '@tauri-apps/plugin-opener'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { useOAuthConnect, type OAuthDependencies } from './use-oauth-connect'

const tokens = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: 'email profile',
}
const userInfo = { email: 'test@example.com', name: 'Test User', id: '123', verified_email: true }
const callback = { code: 'code', state: 'nonce' }
const createDependencies = () => ({
  startOAuthFlowLoopback: mock(async () => ({ tokens, userInfo })),
  redirectOAuthFlow: mock<NonNullable<OAuthDependencies['redirectOAuthFlow']>>(
    async (_httpClient, provider, oauthRelayUrl) => {
      setOAuthState({ state: 'nonce', provider, verifier: 'verifier', oauthRelayUrl })
      throw new Error('Redirecting for OAuth')
    },
  ),
  exchangeCodeForTokens: mock<NonNullable<OAuthDependencies['exchangeCodeForTokens']>>(async () => tokens),
  getUserInfo: mock<NonNullable<OAuthDependencies['getUserInfo']>>(async () => userInfo),
})

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  await resetTestDatabase()
  clearOAuthState()
  sessionStorage.clear()
})
afterEach(cleanup)

/** Mount with isolated mocks while exercising real credential persistence. */
const mount = (options: Parameters<typeof useOAuthConnect>[0] = {}) => {
  const dependencies = createDependencies()
  const onSuccess = mock()
  const onError = mock()
  const hook = renderHook(() => useOAuthConnect({ dependencies, onSuccess, onError, ...options }), {
    wrapper: createQueryTestWrapper(),
  })
  return { ...hook, dependencies, onSuccess, onError }
}

/** Prepare the PKCE state a redirect or mobile deep link must validate. */
const prepareCallback = () => setOAuthState({ state: callback.state, provider: 'google', verifier: 'verifier' })

describe('desktop OAuth', () => {
  const createSpies = () => ({
    tauri: spyOn(platform, 'isTauri').mockReturnValue(true),
    mobile: spyOn(platform, 'isMobile').mockReturnValue(false),
  })
  let spies: ReturnType<typeof createSpies>
  beforeEach(() => {
    spies = createSpies()
  })
  afterEach(() => {
    Object.values(spies).forEach((spy) => spy.mockRestore())
  })

  it.each(['google', 'microsoft'] as const)(
    'persists %s credentials and the preferred name before announcing success',
    async (provider) => {
      const { result, onSuccess, onError, dependencies } = mount({ setPreferredName: true })
      await act(async () => result.current.connect(provider))
      expect(dependencies.startOAuthFlowLoopback).toHaveBeenCalledTimes(1)
      expect(dependencies.redirectOAuthFlow).not.toHaveBeenCalled()
      expect(await getIntegrationCredentials(getDb(), provider)).toMatchObject({
        enabled: true,
        credentials: { access_token: tokens.access_token, profile: { email: userInfo.email } },
      })
      expect(await getSettingsRecords(getDb(), ['preferred_name'])).toMatchObject([{ value: 'Test User' }])
      expect(result.current.isConnecting).toBe(false)
      expect(result.current.error).toBeNull()
      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
    },
  )

  it('keeps a native operation busy past the redirect timeout and rejects overlap', async () => {
    const response = Promise.withResolvers<{ tokens: typeof tokens; userInfo: typeof userInfo } | null>()
    const start = mock(() => response.promise)
    const { result, onSuccess } = mount({ dependencies: { startOAuthFlowLoopback: start } })
    let pending: Promise<void>
    act(() => {
      pending = result.current.connect('google')
    })
    await act(async () => getClock().tickAsync(16_000))
    expect(result.current.isConnecting).toBe(true)
    await act(async () => result.current.connect('google'))
    expect(start).toHaveBeenCalledTimes(1)
    await act(async () => {
      response.resolve(null)
      await pending
    })
    expect(result.current.isConnecting).toBe(false)
    expect(result.current.error).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('oauth_connecting_google')).toBeNull()
  })

  it('surfaces a native error and allows a retry', async () => {
    const { result, dependencies, onError } = mount()
    dependencies.startOAuthFlowLoopback.mockRejectedValueOnce(new Error('Loopback unavailable'))
    await act(async () => result.current.connect('google'))
    expect(result.current.error).toBe('Loopback unavailable')
    expect(result.current.isConnecting).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    await act(async () => result.current.connect('google'))
    expect(result.current.error).toBeNull()
    expect(await getIntegrationCredentials(getDb(), 'google')).not.toBeNull()
  })
})

describe('web OAuth', () => {
  it.each(['google', 'microsoft'] as const)(
    'redirects %s with its security state and return context',
    async (provider) => {
      const { result, dependencies, onError } = mount({ returnContext: 'onboarding' })
      await act(async () => result.current.connect(provider))
      expect(dependencies.redirectOAuthFlow).toHaveBeenCalledTimes(1)
      expect(getOAuthState()).toMatchObject({
        provider,
        returnContext: 'onboarding',
        state: 'nonce',
        oauthRelayUrl: getIntegrationRelayUrl(),
      })
      expect(result.current.isConnecting).toBe(true)
      expect(onError).not.toHaveBeenCalled()
    },
  )

  it('does not restore a stale cosmetic indicator after navigation', () => {
    sessionStorage.setItem('oauth_connecting_google', 'true')
    sessionStorage.setItem('oauth_connecting_google_timestamp', String(Date.now()))
    const { result } = mount()
    expect(result.current.isConnecting).toBe(false)
  })
})

describe('mobile OAuth browser handoff', () => {
  const createSpies = () => ({
    tauri: spyOn(platform, 'isTauri').mockReturnValue(true),
    mobile: spyOn(platform, 'isMobile').mockReturnValue(true),
    url: spyOn(auth, 'buildAuthUrl').mockResolvedValue('https://provider.example/authorize'),
    open: spyOn(opener, 'openUrl').mockResolvedValue(undefined),
  })
  let spies: ReturnType<typeof createSpies>
  beforeEach(() => {
    spies = createSpies()
  })
  afterEach(() => Object.values(spies).forEach((spy) => spy.mockRestore()))

  it('remains usable if the browser is dismissed, without discarding PKCE state', async () => {
    const { result, onSuccess } = mount()
    await act(async () => result.current.connect('google'))
    const pending = getOAuthState()
    expect(pending).toMatchObject({ provider: 'google', returnContext: 'integrations' })
    expect(pending.state).toBeTruthy()
    expect(pending.verifier).toBeTruthy()
    expect(spies.open).toHaveBeenCalledWith('https://provider.example/authorize')
    expect(result.current.isConnecting).toBe(false)
    expect(onSuccess).not.toHaveBeenCalled()
    await act(async () => result.current.connect('google'))
    expect(getOAuthState().state).not.toBe(pending.state)
    expect(spies.open).toHaveBeenCalledTimes(2)
  })

  it('handles a returned callback after the app is remounted', async () => {
    const first = mount()
    await act(async () => first.result.current.connect('google'))
    const pending = getOAuthState()
    first.unmount()
    const returned = mount()
    expect(returned.result.current.isConnecting).toBe(false)
    await act(async () =>
      expect(await returned.result.current.processCallback({ code: 'code', state: pending.state! })).toBe(true),
    )
    expect(returned.onSuccess).toHaveBeenCalledTimes(1)
    expect(await getIntegrationCredentials(getDb(), 'google')).toMatchObject({ enabled: true })
  })

  it('shows a browser-launch failure and permits retry', async () => {
    spies.open.mockRejectedValueOnce(new Error('Unable to open browser'))
    const { result, onError } = mount()
    await act(async () => result.current.connect('google'))
    expect(result.current.error).toBe('Unable to open browser')
    expect(result.current.isConnecting).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    await act(async () => result.current.connect('google'))
    expect(result.current.error).toBeNull()
    expect(spies.open).toHaveBeenCalledTimes(2)
  })
})

describe('OAuth callback ownership', () => {
  it('validates PKCE and persists credentials before reporting success', async () => {
    prepareCallback()
    const { result, dependencies, onSuccess } = mount()
    await act(async () => expect(await result.current.processCallback(callback)).toBe(true))
    expect(dependencies.exchangeCodeForTokens).toHaveBeenCalledWith(expect.anything(), 'google', 'code', 'verifier')
    expect(dependencies.getUserInfo).toHaveBeenCalledWith('google', tokens.access_token)
    expect(await getIntegrationCredentials(getDb(), 'google')).toMatchObject({ enabled: true })
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(result.current.isConnecting).toBe(false)
    expect(getOAuthState().state).toBeNull()
  })

  it.each([{ code: 'code', state: 'wrong-nonce' }, { code: 'code' }, { state: 'nonce' }])(
    'never exchanges an invalid callback: %j',
    async (invalid) => {
      prepareCallback()
      const { result, dependencies, onSuccess } = mount()
      await act(async () => expect(await result.current.processCallback(invalid)).toBe(false))
      expect(dependencies.exchangeCodeForTokens).not.toHaveBeenCalled()
      expect(onSuccess).not.toHaveBeenCalled()
      expect(getOAuthState().state).toBe('nonce')
    },
  )

  it('surfaces and clears provider denial', async () => {
    prepareCallback()
    const { result, onError } = mount()
    await act(async () =>
      expect(await result.current.processCallback({ error: 'access_denied', state: 'nonce' })).toBe(false),
    )
    expect(result.current.error).toBe('access_denied')
    expect(onError).toHaveBeenCalledTimes(1)
    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
  })

  it('claims a callback across consumers and preserves a newer redirect during completion', async () => {
    prepareCallback()
    const response = Promise.withResolvers<typeof tokens>()
    const exchange = mock(() => response.promise)
    const dependencies = { ...createDependencies(), exchangeCodeForTokens: exchange }
    const first = mount({ dependencies })
    const other = mount({ dependencies })
    await act(async () => {
      const pending = first.result.current.processCallback(callback)
      expect(await first.result.current.processCallback(callback)).toBe(false)
      expect(await other.result.current.processCallback(callback)).toBe(false)
      expect(exchange).toHaveBeenCalledTimes(1)
      setOAuthState({ state: 'new-nonce', provider: 'google', verifier: 'new-verifier' })
      response.resolve(tokens)
      expect(await pending).toBe(true)
    })
    expect(first.onSuccess).toHaveBeenCalledTimes(1)
    expect(other.onSuccess).not.toHaveBeenCalled()
    expect(getOAuthState()).toMatchObject({ state: 'new-nonce', provider: 'google' })
  })

  it('does not read or persist credentials after the callback owner unmounts', async () => {
    prepareCallback()
    const response = Promise.withResolvers<typeof tokens>()
    const dependencies = { ...createDependencies(), exchangeCodeForTokens: mock(() => response.promise) }
    const { result, unmount, onSuccess } = mount({ dependencies })
    const pending = result.current.processCallback(callback)
    unmount()
    response.resolve(tokens)
    expect(await pending).toBe(false)
    expect(dependencies.getUserInfo).not.toHaveBeenCalled()
    expect(await getIntegrationCredentials(getDb(), 'google')).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it.each(['exchange', 'profile'] as const)(
    'settles a failed %s and requires a fresh authorization code',
    async (stage) => {
      prepareCallback()
      const { result, dependencies, onError } = mount()
      if (stage === 'exchange') {
        dependencies.exchangeCodeForTokens.mockRejectedValueOnce(new Error('Unavailable'))
      } else {
        dependencies.getUserInfo.mockRejectedValueOnce(new Error('Unavailable'))
      }
      await act(async () => expect(await result.current.processCallback(callback)).toBe(false))
      expect(result.current.error).toBe('Unavailable')
      expect(result.current.isConnecting).toBe(false)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(getOAuthState().state).toBeNull()
      expect(await getIntegrationCredentials(getDb(), 'google')).toBeNull()
    },
  )
})

it.each([undefined, 'old-nonce'])('ignores a provider error with an unrelated nonce: %s', async (state) => {
  prepareCallback()
  const { result, onError } = mount()
  await act(async () => expect(await result.current.processCallback({ error: 'access_denied', state })).toBe(false))
  expect(result.current.error).toBeNull()
  expect(onError).not.toHaveBeenCalled()
  expect(getOAuthState()).toMatchObject({ state: 'nonce', provider: 'google' })
})

describe('OAuth identity isolation', () => {
  let mockDeps: ReturnType<typeof createDependencies>
  beforeEach(() => {
    mockDeps = createDependencies()
  })

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
})
