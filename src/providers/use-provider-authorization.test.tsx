/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as opener from '@tauri-apps/plugin-opener'
import * as platform from '@/lib/platform'
import * as browserAuth from '@/lib/provider-browser-auth'
import * as openrouter from '@/lib/openrouter-auth'
import * as otari from '@/lib/otari-auth'
import * as otariBrowser from '@/lib/otari-browser-auth'
import * as tinfoilMobile from '@/lib/tinfoil-mobile-auth'
import * as tinfoilSession from '@/lib/tinfoil-session'
import * as capabilities from '@/integrations/otari-search/capabilities'
import { tinfoilAuth } from '@/lib/tinfoil-auth'
import { getProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import {
  disconnectProviderConnection,
  getProviderConnections,
  getProviderCredentials,
  saveProviderConnection,
} from '@/dal/provider-connections'
import { getAllModels } from '@/dal/models'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createTestProvider } from '@/test-utils/test-provider'
import { rejectNestedTransactions } from '@/test-utils/flat-transactions'
import { getClock } from '@/testing-library'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { useProviderAuthorization } from './use-provider-authorization'

/** Exercise real credential persistence while replacing external authorization transports. */
const setup = () => {
  const onConnected = mock((_id: string) => {})
  return {
    onConnected,
    ...renderHook(() => useProviderAuthorization({ onConnected }), { wrapper: createTestProvider() }),
  }
}

describe('provider authorization without a model', () => {
  beforeEach(async () => {
    await resetTestDatabase()
    rejectNestedTransactions(getDb())
    sessionStorage.removeItem('thunderbolt-provider-authorization-draft')
    localStorage.removeItem('thunderbolt-provider-authorization-draft')
    spyOn(platform, 'isTauri').mockReturnValue(true)
    spyOn(platform, 'isMobile').mockReturnValue(false)
    spyOn(otariBrowser, 'getOtariBrowserReturn').mockReturnValue(null)
    spyOn(tinfoilMobile, 'getTinfoilMobileReturn').mockReturnValue(null)
    spyOn(capabilities, 'loadOtariSearchStatus').mockResolvedValue('available')
    spyOn(tinfoilSession, 'withTinfoilSessionLock').mockImplementation(async (operation) => operation())
  })
  afterEach(() => {
    cleanup()
    mock.restore()
    useSearchProviderStore.getState().clearSearchProvider()
  })
  afterAll(teardownTestDatabase)

  it.each(['openrouter', 'tinfoil'] as const)(
    'redirects browser %s in the same tab without starting a popup flow',
    async (provider) => {
      spyOn(platform, 'isTauri').mockReturnValue(false)
      const redirect = spyOn(browserAuth, 'startProviderBrowserConnection').mockResolvedValue()
      const popup = spyOn(openrouter, 'startOpenRouterConnection').mockResolvedValue('unused')
      const tinfoilPopup = spyOn(tinfoilAuth, 'startConnection').mockResolvedValue({
        access_token: 'unused',
        expires_at: 999999,
      })
      const { result } = setup()
      await act(async () => result.current.authorize({ provider, name: provider }))
      expect(redirect).toHaveBeenCalledWith(
        provider,
        'connections',
        expect.objectContaining({ provider }),
        expect.any(AbortSignal),
      )
      expect(popup).not.toHaveBeenCalled()
      expect(tinfoilPopup).not.toHaveBeenCalled()
      expect(await getProviderConnections(getDb())).toEqual([])
    },
  )

  it('saves OpenRouter independently of any model and reports its stable connection ID', async () => {
    spyOn(openrouter, 'startOpenRouterConnection').mockResolvedValue('openrouter-token')
    const { result, onConnected } = setup()
    await act(async () => result.current.authorize({ provider: 'openrouter', name: 'My OpenRouter' }))
    expect(onConnected).toHaveBeenCalledWith('oauth:openrouter')
    expect(await getProviderConnections(getDb())).toMatchObject([
      { id: 'oauth:openrouter', name: 'My OpenRouter', authMethod: 'oauth', connected: true },
    ])
    expect((await getProviderCredentials(getDb(), 'oauth:openrouter'))?.access_token).toBe('openrouter-token')
    expect(await getAllModels(getDb())).toEqual([])
    expect(result.current.isPending).toBe(false)
  })

  it('records Tinfoil search capability and retains refresh credentials without changing search selection', async () => {
    spyOn(tinfoilAuth, 'startConnection').mockResolvedValue({
      access_token: 'tinfoil-token',
      refresh_token: 'refresh',
      expires_at: Date.now() + 900_000,
    })
    const { result } = setup()
    await act(async () => result.current.authorize({ provider: 'tinfoil', name: 'Tinfoil' }))
    expect(await getProviderCredentials(getDb(), 'oauth:tinfoil')).toMatchObject({
      access_token: 'tinfoil-token',
      refresh_token: 'refresh',
    })
    expect(useSearchProviderStore.getState()).toMatchObject({
      selection: 'auto',
      connectionId: null,
      connectionStatus: { connectionId: 'oauth:tinfoil', status: 'available' },
    })
    expect(await getAllModels(getDb())).toEqual([])
  })

  it('uses desktop loopback with the Otari origin and records an unavailable search capability', async () => {
    spyOn(platform, 'isTauri').mockReturnValue(true)
    const connect = spyOn(otari, 'connectOtari').mockResolvedValue('otari-token')
    spyOn(capabilities, 'loadOtariSearchStatus').mockResolvedValue('not_configured')
    const { result, onConnected } = setup()
    await act(async () =>
      result.current.authorize({ provider: 'otari', name: 'Work', url: 'https://otari.example.com/api/v1' }),
    )
    expect(connect).toHaveBeenCalledWith('https://otari.example.com', expect.any(AbortSignal))
    expect(onConnected).toHaveBeenCalledWith('oauth:otari')
    expect((await getProviderConnections(getDb()))[0].url).toBe('https://otari.example.com/api/v1')
    expect(useSearchProviderStore.getState()).toMatchObject({
      selection: 'auto',
      connectionStatus: { connectionId: 'oauth:otari', status: 'not_configured' },
    })
    expect(await getAllModels(getDb())).toEqual([])
  })

  it('redirects browser Otari authorization and persists nothing until it returns', async () => {
    spyOn(platform, 'isTauri').mockReturnValue(false)
    const redirect = spyOn(otariBrowser, 'startOtariBrowserConnection').mockResolvedValue()
    const { result, onConnected } = setup()
    await act(async () => result.current.authorize({ provider: 'otari', name: 'Otari' }))
    expect(redirect).toHaveBeenCalledWith(
      'https://otari.ai',
      'connections',
      expect.any(AbortSignal),
      expect.objectContaining({ provider: 'otari' }),
    )
    expect(result.current.isPending).toBe(true)
    expect(await getProviderConnections(getDb())).toEqual([])
    expect(onConnected).not.toHaveBeenCalled()
    act(() => result.current.cancel())
    expect(redirect.mock.calls[0][2].aborted).toBe(true)
    expect(sessionStorage.getItem('thunderbolt-provider-authorization-draft')).toBeNull()
  })

  it('starts native Tinfoil authorization and preserves its draft across app termination', async () => {
    spyOn(platform, 'isTauri').mockReturnValue(true)
    spyOn(platform, 'isMobile').mockReturnValue(true)
    const start = spyOn(tinfoilMobile, 'startTinfoilMobileConnection').mockResolvedValue()
    const { result } = setup()
    await act(async () => result.current.authorize({ provider: 'tinfoil', name: 'Personal' }))
    expect(start).toHaveBeenCalledWith(
      'connections',
      expect.objectContaining({ provider: 'tinfoil' }),
      expect.any(AbortSignal),
    )
    expect(JSON.parse(localStorage.getItem('thunderbolt-provider-authorization-draft')!)).toEqual({
      provider: 'tinfoil',
      name: 'Personal',
    })
    expect(await getProviderConnections(getDb())).toEqual([])
  })

  it('uses the matching PKCE verifier for native manual OpenRouter authorization', async () => {
    spyOn(platform, 'isTauri').mockReturnValue(true)
    spyOn(platform, 'isMobile').mockReturnValue(true)
    spyOn(openrouter, 'prepareOpenRouterManualConnection').mockResolvedValue({
      authorizationUrl: 'https://openrouter.ai/auth',
      verifier: 'matching-verifier',
    })
    const open = spyOn(opener, 'openUrl').mockResolvedValue()
    const exchange = spyOn(openrouter, 'exchangeOpenRouterCode')
      .mockRejectedValueOnce(new Error('secret-provider-details'))
      .mockResolvedValue('manual-token')
    const { result } = setup()
    await act(async () => result.current.authorize({ provider: 'openrouter', name: 'Manual' }))
    expect(open).toHaveBeenCalledWith('https://openrouter.ai/auth')
    act(() => result.current.manual!.setCode(' code '))
    await act(async () => result.current.manual!.submit())
    expect(result.current.error).toBe('Could not connect this provider. Please try again.')
    expect(result.current.manual?.code).toBe(' code ')
    expect(await getProviderConnections(getDb())).toEqual([])
    await act(async () => result.current.manual!.submit())
    expect(exchange).toHaveBeenCalledWith('code', 'matching-verifier', expect.any(AbortSignal))
    expect(exchange).toHaveBeenCalledTimes(2)
    expect((await getProviderCredentials(getDb(), 'oauth:openrouter'))?.access_token).toBe('manual-token')
    expect(result.current.manual).toBeNull()
  })

  it('does not save a manual exchange that completes after cancellation', async () => {
    spyOn(platform, 'isTauri').mockReturnValue(true)
    spyOn(platform, 'isMobile').mockReturnValue(true)
    spyOn(openrouter, 'prepareOpenRouterManualConnection').mockResolvedValue({
      authorizationUrl: 'https://openrouter.ai/auth',
      verifier: 'verifier',
    })
    spyOn(opener, 'openUrl').mockResolvedValue()
    const completion = Promise.withResolvers<string>()
    const exchange = spyOn(openrouter, 'exchangeOpenRouterCode').mockImplementation(() => completion.promise)
    const { result, onConnected } = setup()
    await act(async () => result.current.authorize({ provider: 'openrouter', name: 'Manual' }))
    act(() => result.current.manual!.setCode('code'))
    act(() => {
      void result.current.manual!.submit()
    })
    act(() => result.current.cancel())
    expect(exchange.mock.calls[0][2]?.aborted).toBe(true)
    await act(async () => completion.resolve('late-token'))
    expect(await getProviderConnections(getDb())).toEqual([])
    expect(onConnected).not.toHaveBeenCalled()
    expect(result.current.manual).toBeNull()
  })

  it('resumes native Tinfoil credentials and records search capability without a model', async () => {
    spyOn(platform, 'isTauri').mockReturnValue(true)
    spyOn(platform, 'isMobile').mockReturnValue(true)
    localStorage.setItem(
      'thunderbolt-provider-authorization-draft',
      JSON.stringify({ provider: 'tinfoil', name: 'Personal' }),
    )
    spyOn(tinfoilMobile, 'getTinfoilMobileReturn').mockReturnValue({
      id: 'mobile-return',
      context: 'connections',
      returnTo: '/settings/connections',
      attempt: await getProviderConnectionAttempt(getDb(), 'tinfoil'),
      complete: async () => ({
        access_token: 'mobile-token',
        refresh_token: 'refresh',
        expires_at: Date.now() + 900_000,
      }),
      cancel: () => {},
    })
    const { onConnected } = setup()
    await act(async () => {})
    expect(onConnected).toHaveBeenCalledWith('oauth:tinfoil')
    expect((await getProviderCredentials(getDb(), 'oauth:tinfoil'))?.refresh_token).toBe('refresh')
    expect((await getProviderConnections(getDb()))[0].name).toBe('Personal')
    expect(await getAllModels(getDb())).toEqual([])
    expect(useSearchProviderStore.getState()).toMatchObject({
      selection: 'auto',
      connectionId: null,
      connectionStatus: { connectionId: 'oauth:tinfoil', status: 'available' },
    })
  })

  it.each(['cancel', 'unmount'] as const)('ignores an authorization completed after %s', async (action) => {
    const grant = Promise.withResolvers<string>()
    const start = spyOn(openrouter, 'startOpenRouterConnection').mockImplementation(() => grant.promise)
    const { result, onConnected, unmount } = setup()
    act(() => {
      void result.current.authorize({ provider: 'openrouter', name: 'OpenRouter' })
    })
    await act(async () => {})
    if (action === 'cancel') {
      act(() => result.current.cancel())
    } else {
      unmount()
    }
    expect(start.mock.calls[0][0]?.signal?.aborted).toBe(true)
    await act(async () => grant.resolve('must-not-save'))
    expect(await getProviderConnections(getDb())).toEqual([])
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('refuses a grant superseded by another window connecting and disconnecting', async () => {
    const grant = Promise.withResolvers<string>()
    const start = spyOn(openrouter, 'startOpenRouterConnection').mockImplementation(() => grant.promise)
    const { result, onConnected } = setup()
    let authorization: Promise<void>
    act(() => {
      authorization = result.current.authorize({ provider: 'openrouter', name: 'Old attempt' })
    })
    await act(async () => getClock().runAllAsync())
    expect(start).toHaveBeenCalledTimes(1)
    await saveProviderConnection(getDb(), {
      provider: 'openrouter',
      name: 'Other window',
      authMethod: 'oauth',
      credentials: { access_token: 'other-token' },
    })
    await disconnectProviderConnection(getDb(), 'oauth:openrouter')
    await act(async () => {
      grant.resolve('old-token')
      await authorization
    })
    expect(await getProviderCredentials(getDb(), 'oauth:openrouter')).toBeNull()
    expect(result.current.error).toBe('Could not connect this provider. Please try again.')
    expect(result.current.isPending).toBe(false)
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('uses the validated Otari return rather than an editable draft when StrictMode remounts', async () => {
    const grant = Promise.withResolvers<string>()
    sessionStorage.setItem(
      'thunderbolt-provider-authorization-draft',
      JSON.stringify({ provider: 'otari', name: 'Work', url: 'https://attacker.example.com', id: 'wrong-id' }),
    )
    spyOn(otariBrowser, 'getOtariBrowserReturn').mockReturnValue({
      id: 'returned',
      origin: 'https://trusted.example.com',
      context: 'connections',
      returnTo: '/settings/connections',
      attempt: await getProviderConnectionAttempt(getDb(), 'otari'),
      error: null,
      complete: () => grant.promise,
      cancel: () => {},
    })
    const Provider = createTestProvider()
    const onConnected = mock((_id: string) => {})
    renderHook(() => useProviderAuthorization({ onConnected }), {
      wrapper: ({ children }) => (
        <StrictMode>
          <Provider>{children}</Provider>
        </StrictMode>
      ),
    })
    await act(async () => grant.resolve('returned-token'))
    expect(onConnected).toHaveBeenCalledTimes(1)
    expect((await getProviderConnections(getDb()))[0]).toMatchObject({
      id: 'oauth:otari',
      url: 'https://trusted.example.com/api/v1',
      name: 'Work',
    })
    expect(await getAllModels(getDb())).toEqual([])
  })
})
