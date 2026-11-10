/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as mcpOAuth from '@/lib/mcp-auth/web-oauth-flow'
import { setMcpOAuthState, clearMcpOAuthState, getMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import * as chatGPT from './chatgpt-auth'
import * as oauthSession from './oauth-session'
import { getMcpServerCredentials } from '@/dal/mcp-secrets'
import * as opener from '@tauri-apps/plugin-opener'
import * as platform from '@/lib/platform'
import * as browserAuth from '@/lib/provider-browser-auth'
import * as openrouter from '@/lib/openrouter-auth'
import * as otari from '@/lib/otari-auth'
import * as otariBrowser from '@/lib/otari-browser-auth'
import * as tinfoilMobile from '@/lib/tinfoil-mobile-auth'
import * as tinfoilSession from '@/lib/tinfoil-session'
import * as capabilities from '@/integrations/otari-search/capabilities'
import * as providerConnections from '@/dal/provider-connections'
import { createTinfoilAuth, tinfoilAuth } from '@/lib/tinfoil-auth'
import { getProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import {
  disconnectProviderConnection,
  getProviderConnections,
  getProviderCredentials,
  saveProviderConnection,
  updateProviderConnection,
} from '@/dal/provider-connections'
import { getAllModels } from '@/dal/models'
import { getIntegrationCredentials } from '@/dal/integrations'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createTestProvider } from '@/test-utils/test-provider'
import { rejectNestedTransactions } from '@/test-utils/flat-transactions'
import { getClock } from '@/testing-library'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { useProviderAuthorization } from './use-provider-authorization'
import { useConnectionsOAuthCallback } from '@/settings/connections/use-connections-oauth-callback'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'

/** Exercise real credential persistence while replacing external authorization transports. */
const setup = () => {
  const connected = Promise.withResolvers<string>()
  const onConnected = mock((id: string) => connected.resolve(id))
  return {
    onConnected,
    connected: connected.promise,
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
    spyOn(otari, 'revokeOtariToken').mockResolvedValue()
    spyOn(tinfoilMobile, 'getTinfoilMobileReturn').mockReturnValue(null)
    spyOn(tinfoilAuth, 'revoke').mockResolvedValue()
    spyOn(capabilities, 'loadOtariSearchStatus').mockResolvedValue('available')
    spyOn(tinfoilSession, 'withTinfoilSessionLock').mockImplementation(async (operation) => operation())
  })
  afterEach(() => {
    cleanup()
    clearMcpOAuthState()
    mock.restore()
    useSearchProviderStore.getState().clearSearchProvider()
  })
  afterAll(teardownTestDatabase)

  it.each([null, 'saved-client'] as const)(
    'passes the selected ChatGPT registration through and presents declined consent: %s',
    async (chatGPTAccountId) => {
      spyOn(oauthSession, 'withProviderOAuthLock').mockImplementation(async (_id, work) => work())
      const connect = spyOn(chatGPT, 'connectChatGPT').mockResolvedValue({
        access_token: 'identity-access',
        refresh_token: 'identity-refresh',
        reauth_required: true,
        oauth: {
          clientId: 'saved-client',
          issuer: 'https://auth.openai.com',
          tokenEndpoint: 'https://auth.openai.com/token',
          resource: 'https://api.openai.com/v1',
          subject: 'account',
          scope: 'openid',
        },
      })
      const { result, onConnected } = setup()
      await act(async () => result.current.authorize({ provider: 'openai', name: 'OpenAI', chatGPTAccountId }))
      expect(connect.mock.calls[0]?.[3]).toBe(chatGPTAccountId)
      expect(onConnected).toHaveBeenCalledWith('oauth:openai')
      expect(result.current.error).toBeNull()
      expect(result.current.isPending).toBe(false)
      expect(await providerConnections.getProviderConnection(getDb(), 'oauth:openai')).toMatchObject({
        connected: false,
        needsConsent: true,
      })
      expect(await getProviderCredentials(getDb(), 'oauth:openai')).toBeNull()
    },
  )

  it('revokes an issued ChatGPT grant when the guarded connection save fails', async () => {
    const credentials = { access_token: 'new-access', refresh_token: 'new-refresh' }
    spyOn(chatGPT, 'connectChatGPT').mockResolvedValue(credentials)
    const discard = spyOn(chatGPT, 'discardChatGPTAuthorization').mockResolvedValue()
    spyOn(providerConnections, 'saveProviderConnectionWithRevision').mockRejectedValue(new Error('Stale attempt'))
    const { result, onConnected } = setup()
    await act(async () => result.current.authorize({ provider: 'openai', name: 'ChatGPT' }))
    expect(discard).toHaveBeenCalledWith(getDb(), credentials)
    expect(onConnected).not.toHaveBeenCalled()
    expect(result.current.error).toBe('Could not connect this provider. Please try again.')
  })

  it.each(['exa', 'tavily'] as const)(
    'stores %s MCP OAuth as a provider connection without creating an MCP credential',
    async (provider) => {
      const start = spyOn(mcpOAuth, 'startMcpOAuthFlow').mockImplementation(async (args) => {
        await args.saveCredentials!({
          type: 'oauth',
          access_token: 'access',
          refresh_token: 'refresh',
          clientId: 'registered',
          issuer: 'https://auth.example',
          tokenEndpoint: 'https://auth.example/token',
          expires_at: Date.now() + 3600000,
        })
        return { status: 'completed' }
      })
      const { result, onConnected } = setup()
      await act(async () => result.current.authorize({ provider, name: provider }))
      expect(start.mock.calls[0]?.[0].serverId).toBe(`oauth:${provider}`)
      expect(await getProviderCredentials(getDb(), `oauth:${provider}`)).toMatchObject({
        access_token: 'access',
        oauth: { clientId: 'registered' },
      })
      expect(await getMcpServerCredentials(getDb(), `oauth:${provider}`)).toBeNull()
      expect(onConnected).toHaveBeenCalledWith(`oauth:${provider}`)
      expect(result.current.isPending).toBe(false)
    },
  )

  it('completes a mount-triggered MCP callback once under StrictMode', async () => {
    setMcpOAuthState({ serverId: 'oauth:exa', stateNonce: 'nonce' })
    sessionStorage.setItem(
      'thunderbolt-provider-authorization-draft',
      JSON.stringify({
        provider: 'exa',
        name: 'Exa',
        attempt: await getProviderConnectionAttempt(getDb(), 'exa'),
      }),
    )
    const exchange = spyOn(mcpOAuth, 'completeMcpOAuthFlow').mockImplementation(async (args) => {
      clearMcpOAuthState()
      await args.saveCredentials!({
        type: 'oauth',
        access_token: 'returned-access',
        clientId: 'client',
        issuer: 'https://auth.example',
        tokenEndpoint: 'https://auth.example/token',
      })
    })
    const Provider = createTestProvider()
    const connected = Promise.withResolvers<void>()
    const onConnected = mock(() => connected.resolve())
    const locationState = { oauth: { code: 'code', state: 'nonce' } }
    const { result } = renderHook(
      () => {
        const authorization = useProviderAuthorization({ onConnected, resumeReturn: false })
        useConnectionsOAuthCallback({
          locationState,
          processMcpCallback: authorization.processMcpCallback,
          processIntegrationCallback: () => {},
          getIntegrationProvider: () => null,
          dispatch: () => {},
        })
        return authorization
      },
      {
        wrapper: Provider,
        reactStrictMode: true,
      },
    )
    await act(async () => connected.promise)
    expect(result.current.isPending).toBe(false)
    expect(onConnected).toHaveBeenCalledTimes(1)
    expect(exchange).toHaveBeenCalledTimes(1)
  })

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

  it.each(['openrouter', 'tinfoil', 'otari'] as const)(
    'rejects a late %s grant after identity teardown even when the transport returns it',
    async (provider) => {
      spyOn(openrouter, 'startOpenRouterConnection').mockImplementation(async () => {
        invalidateIdentityLifetime()
        return 'retired-token'
      })
      spyOn(tinfoilAuth, 'startConnection').mockImplementation(async () => {
        invalidateIdentityLifetime()
        return { access_token: 'retired-token', expires_at: Date.now() + 900_000 }
      })
      spyOn(otari, 'connectOtari').mockImplementation(async () => {
        invalidateIdentityLifetime()
        return 'retired-token'
      })
      const { result, onConnected } = setup()
      await act(async () => result.current.authorize({ provider, name: 'Retired authorization' }))
      expect(await getProviderConnections(getDb())).toEqual([])
      expect(onConnected).not.toHaveBeenCalled()
      expect(useSearchProviderStore.getState().connectionStatus).toBeNull()
      if (provider === 'otari') {
        expect(otari.revokeOtariToken).toHaveBeenCalledWith('https://otari.ai', 'retired-token')
      }
    },
  )

  it('rejects MCP provider persistence after the initiating identity was retired', async () => {
    spyOn(mcpOAuth, 'startMcpOAuthFlow').mockImplementation(async (args) => {
      invalidateIdentityLifetime()
      await args.saveCredentials!({
        type: 'oauth',
        access_token: 'retired-token',
        clientId: 'client',
        issuer: 'https://auth.example',
        tokenEndpoint: 'https://auth.example/token',
      })
      return { status: 'completed' }
    })
    const { result, onConnected } = setup()
    await act(async () => result.current.authorize({ provider: 'exa', name: 'Retired Exa' }))
    expect(await getProviderConnections(getDb())).toEqual([])
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('does not clear the next identity’s MCP handshake when an old callback rejects late', async () => {
    setMcpOAuthState({ serverId: 'oauth:exa', stateNonce: 'old-nonce' })
    sessionStorage.setItem(
      'thunderbolt-provider-authorization-draft',
      JSON.stringify({
        provider: 'exa',
        name: 'Old Exa',
        attempt: await getProviderConnectionAttempt(getDb(), 'exa'),
      }),
    )
    spyOn(mcpOAuth, 'completeMcpOAuthFlow').mockImplementation(async () => {
      invalidateIdentityLifetime()
      setMcpOAuthState({ serverId: 'oauth:tavily', stateNonce: 'next-identity-nonce' })
      throw new Error('Retired callback')
    })
    const { result, onConnected } = setup()
    await act(async () => result.current.processMcpCallback({ code: 'code', state: 'old-nonce' }))
    expect(getMcpOAuthState()).toMatchObject({ serverId: 'oauth:tavily', stateNonce: 'next-identity-nonce' })
    expect(onConnected).not.toHaveBeenCalled()
  })

  it.each(['exa', 'tavily'] as const)(
    'stores %s MCP OAuth as a provider connection without creating an MCP credential',
    async (provider) => {
      const start = spyOn(mcpOAuth, 'startMcpOAuthFlow').mockImplementation(async (args) => {
        await args.saveCredentials!({
          type: 'oauth',
          access_token: 'access',
          refresh_token: 'refresh',
          clientId: 'registered',
          issuer: 'https://auth.example',
          tokenEndpoint: 'https://auth.example/token',
          expires_at: Date.now() + 3600000,
        })
        return { status: 'completed' }
      })
      const { result, onConnected } = setup()
      await act(async () => result.current.authorize({ provider, name: provider }))
      expect(start.mock.calls[0]?.[0].serverId).toBe(`oauth:${provider}`)
      expect(await getProviderCredentials(getDb(), `oauth:${provider}`)).toMatchObject({
        access_token: 'access',
        oauth: { clientId: 'registered' },
      })
      expect(await getMcpServerCredentials(getDb(), `oauth:${provider}`)).toBeNull()
      expect(onConnected).toHaveBeenCalledWith(`oauth:${provider}`)
      expect(result.current.isPending).toBe(false)
    },
  )

  it.each(['openrouter', 'tinfoil'] as const)(
    'rejects %s disabled immediately after the authorization save commits',
    async (provider) => {
      spyOn(openrouter, 'startOpenRouterConnection').mockResolvedValue('new-token')
      spyOn(tinfoilAuth, 'startConnection').mockResolvedValue({
        access_token: 'new-token',
        expires_at: Date.now() + 900_000,
      })
      const save = providerConnections.saveProviderConnectionWithRevision
      spyOn(providerConnections, 'saveProviderConnectionWithRevision').mockImplementationOnce(async (...args) => {
        const receipt = await save(...args)
        await updateProviderConnection(getDb(), receipt.id, { enabled: false })
        return receipt
      })
      const { result, onConnected } = setup()
      await act(async () => result.current.authorize({ provider, name: provider }))
      expect(onConnected).not.toHaveBeenCalled()
      expect(result.current.error).toBe('Could not connect this provider. Please try again.')
      expect(useSearchProviderStore.getState().connectionStatus).toBeNull()
      expect((await getProviderConnections(getDb()))[0].enabled).toBe(0)
    },
  )

  it.each(['cancel', 'unmount', 'identity'] as const)('releases a late Tinfoil grant after %s', async (action) => {
    const grant = Promise.withResolvers<Awaited<ReturnType<typeof tinfoilAuth.startConnection>>>()
    const started = Promise.withResolvers<void>()
    spyOn(tinfoilAuth, 'startConnection').mockImplementation(() => {
      started.resolve()
      return grant.promise
    })
    const { result, unmount, onConnected } = setup()
    const connecting = result.current.authorize({ provider: 'tinfoil', name: 'Tinfoil' })
    await started.promise
    act(() => {
      if (action === 'cancel') {
        result.current.cancel()
      } else if (action === 'unmount') {
        unmount()
      } else {
        invalidateIdentityLifetime()
      }
    })
    await act(async () => {
      grant.resolve({ access_token: 'unused', refresh_token: 'unused-refresh', expires_at: Date.now() + 900_000 })
      await connecting
    })
    expect(tinfoilAuth.revoke).toHaveBeenCalledWith('unused-refresh')
    expect(await getProviderCredentials(getDb(), 'oauth:tinfoil')).toBeNull()
    expect(onConnected).not.toHaveBeenCalled()
  })

  it.each(
    (['headers', 'body'] as const).flatMap((phase) =>
      (['cancel', 'identity'] as const).map((action) => ({ phase, action })),
    ),
  )('cleans up an issued Tinfoil grant after token-response interruption: %j', async ({ phase, action }) => {
    const requested = Promise.withResolvers<Request>()
    const headers = Promise.withResolvers<Response>()
    const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const response = new Response(new ReadableStream<Uint8Array>({ start: (controller) => body.resolve(controller) }))
    const requests: Request[] = []
    const auth = createTinfoilAuth('client', {
      fetch: async (input) => {
        const request = input as Request
        requests.push(request)
        if (request.url.endsWith('/revoke')) {
          return new Response(null, { status: 204 })
        }
        requested.resolve(request)
        return headers.promise
      },
    })
    spyOn(tinfoilAuth, 'startConnection').mockImplementation((options = {}) =>
      auth.exchangeCode(
        {
          code: 'code',
          verifier: 'verifier',
          redirectUri: 'https://app.example/oauth/tinfoil',
        },
        options.signal,
      ),
    )
    spyOn(tinfoilAuth, 'revoke').mockImplementation(auth.revoke)
    const { result, onConnected } = setup()
    const connecting = result.current.authorize({ provider: 'tinfoil', name: 'Tinfoil' })
    const request = await requested.promise
    if (phase === 'body') {
      await act(async () => headers.resolve(response))
    }
    act(() => {
      if (action === 'cancel') {
        result.current.cancel()
      } else {
        invalidateIdentityLifetime()
      }
    })
    if (action === 'cancel') {
      expect(result.current.isPending).toBe(false)
    }
    expect(request.signal.aborted).toBe(false)
    await act(async () => {
      headers.resolve(response)
      const stream = await body.promise
      stream.enqueue(
        new TextEncoder().encode(
          JSON.stringify({
            access_token: 'unused',
            refresh_token: 'unused-refresh',
            expires_in: 900,
            token_type: 'Bearer',
          }),
        ),
      )
      stream.close()
      await connecting
    })
    expect(requests).toHaveLength(2)
    expect(requests[1].url).toBe('https://api.tinfoil.sh/oauth/revoke')
    expect(new URLSearchParams(await requests[1].text()).get('token')).toBe('unused-refresh')
    expect(await getProviderCredentials(getDb(), 'oauth:tinfoil')).toBeNull()
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('releases an unused Tinfoil grant when saving fails without disconnecting the current account', async () => {
    await saveProviderConnection(getDb(), {
      provider: 'tinfoil',
      name: 'Existing',
      authMethod: 'oauth',
      credentials: { access_token: 'saved', refresh_token: 'saved-refresh' },
    })
    spyOn(tinfoilAuth, 'startConnection').mockResolvedValue({
      access_token: 'unused',
      refresh_token: 'unused-refresh',
      expires_at: Date.now() + 900_000,
    })
    spyOn(providerConnections, 'saveProviderConnectionWithRevision').mockRejectedValue(new Error('stale'))
    const { result } = setup()
    await act(async () => result.current.authorize({ provider: 'tinfoil', name: 'Tinfoil' }))
    expect(tinfoilAuth.revoke).toHaveBeenCalledTimes(1)
    expect(tinfoilAuth.revoke).toHaveBeenCalledWith('unused-refresh')
    expect((await getProviderCredentials(getDb(), 'oauth:tinfoil'))?.access_token).toBe('saved')
  })

  it('does not revoke the Tinfoil grant transferred to a StrictMode replacement effect', async () => {
    const grant = Promise.withResolvers<Awaited<ReturnType<typeof tinfoilAuth.startConnection>>>()
    spyOn(tinfoilMobile, 'getTinfoilMobileReturn').mockReturnValue({
      id: 'shared-return',
      context: 'connections',
      returnTo: '/chats/new',
      attempt: await getProviderConnectionAttempt(getDb(), 'tinfoil'),
      complete: () => grant.promise,
      cancel: () => {},
    })
    const connected = Promise.withResolvers<void>()
    const onConnected = mock(() => connected.resolve())
    renderHook(() => useProviderAuthorization({ onConnected }), {
      wrapper: createTestProvider(),
      reactStrictMode: true,
    })
    await act(async () => {
      grant.resolve({ access_token: 'saved', refresh_token: 'saved-refresh', expires_at: Date.now() + 900_000 })
      await connected.promise
    })
    expect(onConnected).toHaveBeenCalledTimes(1)
    expect(tinfoilAuth.revoke).not.toHaveBeenCalled()
    expect((await getProviderCredentials(getDb(), 'oauth:tinfoil'))?.access_token).toBe('saved')
  })

  it('cleans up a cancelled Tinfoil mobile return when a different native authorization takes over', async () => {
    const old = Promise.withResolvers<Awaited<ReturnType<typeof tinfoilAuth.startConnection>>>()
    const oldStarted = Promise.withResolvers<void>()
    spyOn(tinfoilMobile, 'getTinfoilMobileReturn').mockReturnValue({
      id: 'old-return',
      context: 'connections',
      returnTo: '/chats/new',
      attempt: await getProviderConnectionAttempt(getDb(), 'tinfoil'),
      complete: () => {
        oldStarted.resolve()
        return old.promise
      },
      cancel: () => {},
    })
    const { result } = setup()
    await oldStarted.promise
    act(() => result.current.cancel())
    const next = Promise.withResolvers<Awaited<ReturnType<typeof tinfoilAuth.startConnection>>>()
    const nextStarted = Promise.withResolvers<void>()
    spyOn(tinfoilAuth, 'startConnection').mockImplementation(() => {
      nextStarted.resolve()
      return next.promise
    })
    const connecting = result.current.authorize({ provider: 'tinfoil', name: 'New account' })
    await nextStarted.promise
    await act(async () => {
      old.resolve({ access_token: 'old-unused', refresh_token: 'old-unused-refresh', expires_at: Date.now() + 900_000 })
      await getClock().tickAsync(0)
    })
    expect(tinfoilAuth.revoke).toHaveBeenCalledWith('old-unused-refresh')
    await act(async () => {
      next.resolve({ access_token: 'new', refresh_token: 'new-refresh', expires_at: Date.now() + 900_000 })
      await connecting
    })
    expect((await getProviderCredentials(getDb(), 'oauth:tinfoil'))?.access_token).toBe('new')
    expect(tinfoilAuth.revoke).not.toHaveBeenCalledWith('new-refresh')
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
    const started = Promise.withResolvers<void>()
    const exchange = spyOn(openrouter, 'exchangeOpenRouterCode').mockImplementation(() => {
      started.resolve()
      return completion.promise
    })
    const { result, onConnected } = setup()
    await act(async () => result.current.authorize({ provider: 'openrouter', name: 'Manual' }))
    act(() => result.current.manual!.setCode('code'))
    await act(async () => {
      void result.current.manual!.submit()
      await started.promise
    })
    act(() => result.current.cancel())
    expect(exchange.mock.calls[0][2]?.aborted).toBe(true)
    await act(async () => completion.resolve('late-token'))
    expect(await getProviderConnections(getDb())).toEqual([])
    expect(onConnected).not.toHaveBeenCalled()
    expect(result.current.manual).toBeNull()
  })

  it('retires a manual OpenRouter verifier with its initiating identity before submission', async () => {
    spyOn(platform, 'isMobile').mockReturnValue(true)
    spyOn(openrouter, 'prepareOpenRouterManualConnection').mockResolvedValue({
      authorizationUrl: 'https://openrouter.ai/auth',
      verifier: 'retired-verifier',
    })
    spyOn(opener, 'openUrl').mockResolvedValue()
    const exchange = spyOn(openrouter, 'exchangeOpenRouterCode').mockResolvedValue('retired-token')
    const { result, onConnected } = setup()
    await act(async () => result.current.authorize({ provider: 'openrouter', name: 'Manual' }))
    invalidateIdentityLifetime()
    act(() => result.current.manual!.setCode('code'))
    await act(async () => result.current.manual!.submit())
    expect(exchange).not.toHaveBeenCalled()
    expect(await getProviderConnections(getDb())).toEqual([])
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('rejects a superseded manual authorization before exchanging its code', async () => {
    spyOn(platform, 'isMobile').mockReturnValue(true)
    spyOn(openrouter, 'prepareOpenRouterManualConnection').mockResolvedValue({
      authorizationUrl: 'https://openrouter.ai/auth',
      verifier: 'verifier',
    })
    spyOn(opener, 'openUrl').mockResolvedValue()
    const exchange = spyOn(openrouter, 'exchangeOpenRouterCode').mockResolvedValue('stale-token')
    const { result, onConnected } = setup()
    await act(async () => result.current.authorize({ provider: 'openrouter', name: 'Manual' }))
    await saveProviderConnection(getDb(), {
      provider: 'openrouter',
      name: 'New account',
      authMethod: 'oauth',
      credentials: { access_token: 'current-token' },
    })
    act(() => result.current.manual!.setCode('code'))
    await act(async () => result.current.manual!.submit())
    expect(exchange).not.toHaveBeenCalled()
    expect(onConnected).not.toHaveBeenCalled()
    expect(result.current.error).toBe('Could not connect this provider. Please try again.')
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
    const { onConnected, connected } = setup()
    await act(async () => {
      await connected
    })
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
    const connected = Promise.withResolvers<string>()
    const onConnected = mock((id: string) => connected.resolve(id))
    renderHook(() => useProviderAuthorization({ onConnected }), {
      wrapper: Provider,
      reactStrictMode: true,
    })
    await act(async () => {
      grant.resolve('returned-token')
      await connected.promise
    })
    expect(onConnected).toHaveBeenCalledTimes(1)
    expect((await getProviderConnections(getDb()))[0]).toMatchObject({
      id: 'oauth:otari',
      url: 'https://trusted.example.com/api/v1',
      name: 'Work',
    })
    expect(await getAllModels(getDb())).toEqual([])
  })

  it('revokes a cancelled redirect token when a new native authorization takes over', async () => {
    const oldGrant = Promise.withResolvers<string>()
    const exchangeStarted = Promise.withResolvers<void>()
    spyOn(otariBrowser, 'getOtariBrowserReturn').mockReturnValue({
      id: 'old-return',
      origin: 'https://old.example',
      context: 'connections',
      returnTo: '/chats/new',
      attempt: await getProviderConnectionAttempt(getDb(), 'otari'),
      error: null,
      cancel: () => {},
      complete: () => {
        exchangeStarted.resolve()
        return oldGrant.promise
      },
    })
    const { result } = setup()
    await exchangeStarted.promise
    act(() => result.current.cancel())
    const nextGrant = Promise.withResolvers<string>()
    const nextStarted = Promise.withResolvers<void>()
    spyOn(otari, 'connectOtari').mockImplementation(() => {
      nextStarted.resolve()
      return nextGrant.promise
    })
    const next = result.current.authorize({ provider: 'otari', name: 'New account' })
    await nextStarted.promise
    await act(async () => {
      oldGrant.resolve('old-unused-token')
      await getClock().tickAsync(0)
    })
    expect(otari.revokeOtariToken).toHaveBeenCalledWith('https://old.example', 'old-unused-token')
    await act(async () => {
      nextGrant.resolve('new-token')
      await next
    })
    expect((await getProviderCredentials(getDb(), 'oauth:otari'))?.access_token).toBe('new-token')
    expect(otari.revokeOtariToken).not.toHaveBeenCalledWith('https://otari.ai', 'new-token')
  })

  it('rejects a superseded browser return before minting another credential', async () => {
    const attempt = await getProviderConnectionAttempt(getDb(), 'otari')
    await saveProviderConnection(getDb(), {
      provider: 'otari',
      name: 'Current account',
      authMethod: 'oauth',
      url: 'https://otari.example.com/api/v1',
      credentials: { access_token: 'current-token' },
    })
    const complete = mock(async () => 'stale-token')
    spyOn(otariBrowser, 'getOtariBrowserReturn').mockReturnValue({
      id: 'old-return',
      origin: 'https://otari.example.com',
      context: 'connections',
      returnTo: '/settings/connections',
      attempt,
      error: null,
      complete,
      cancel: () => {},
    })
    const { result, onConnected } = setup()
    await act(async () => getClock().runAllAsync())
    await waitForElement(() => (result.current.error ? document.body : null))
    expect(complete).not.toHaveBeenCalled()
    expect(result.current.isPending).toBe(false)
    expect(result.current.error).toBe('Could not connect this provider. Please try again.')
    expect(onConnected).not.toHaveBeenCalled()
    expect((await getProviderCredentials(getDb(), 'oauth:otari'))?.access_token).toBe('current-token')
  })

  it('bounds capability discovery after OAuth even when response parsing stalls', async () => {
    spyOn(otari, 'connectOtari').mockResolvedValue('otari-token')
    const deadline = new AbortController()
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const started = Promise.withResolvers<AbortSignal>()
    spyOn(capabilities, 'loadOtariSearchStatus').mockImplementation(async (_url, _key, signal) => {
      started.resolve(signal)
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const { result, onConnected } = setup()
    const connecting = result.current.authorize({ provider: 'otari', name: 'Otari' })
    const signal = await started.promise
    expect(timeout).toHaveBeenCalledWith(30_000)
    await act(async () => {
      deadline.abort(new DOMException('Discovery timed out', 'TimeoutError'))
      await connecting
    })
    expect(signal.aborted).toBe(true)
    expect(result.current.isPending).toBe(false)
    expect(result.current.error).toBe('Could not connect this provider. Please try again.')
    expect(onConnected).not.toHaveBeenCalled()
    expect((await getProviderCredentials(getDb(), 'oauth:otari'))?.access_token).toBe('otari-token')
    expect(otari.revokeOtariToken).not.toHaveBeenCalled()
  })

  it('preserves an explicitly disabled Otari connection when reconnecting and skips discovery', async () => {
    await saveProviderConnection(getDb(), {
      provider: 'otari',
      name: 'Work',
      authMethod: 'oauth',
      credentials: { access_token: 'old-token' },
      enabled: false,
    })
    spyOn(otari, 'connectOtari').mockResolvedValue('new-token')
    const discovery = spyOn(capabilities, 'loadOtariSearchStatus')
    const { result, onConnected } = setup()
    await act(async () => result.current.authorize({ provider: 'otari', name: 'Work', id: 'oauth:otari' }))
    expect((await getProviderConnections(getDb()))[0]).toMatchObject({ enabled: 0, connected: true })
    expect((await getIntegrationCredentials(getDb(), 'otari'))?.credentials.access_token).toBe('new-token')
    expect(discovery).not.toHaveBeenCalled()
    expect(onConnected).toHaveBeenCalledWith('oauth:otari')
  })

  it.each(['replace', 'disable', 'disconnect'] as const)(
    'ignores capability results for a connection changed during discovery: %s',
    async (change) => {
      spyOn(otari, 'connectOtari').mockResolvedValue('old-token')
      const started = Promise.withResolvers<void>()
      const status = Promise.withResolvers<'available'>()
      spyOn(capabilities, 'loadOtariSearchStatus').mockImplementation(() => {
        started.resolve()
        return status.promise
      })
      const { result, onConnected } = setup()
      const connecting = result.current.authorize({ provider: 'otari', name: 'Original' })
      await started.promise
      if (change === 'replace') {
        await saveProviderConnection(getDb(), {
          provider: 'otari',
          name: 'New account',
          authMethod: 'oauth',
          credentials: { access_token: 'new-token' },
        })
      } else if (change === 'disable') {
        await updateProviderConnection(getDb(), 'oauth:otari', { enabled: false })
      } else {
        await disconnectProviderConnection(getDb(), 'oauth:otari')
      }
      await act(async () => {
        status.resolve('available')
        await connecting
      })
      expect(onConnected).not.toHaveBeenCalled()
      expect(useSearchProviderStore.getState().connectionStatus).toBeNull()
      expect(result.current.isPending).toBe(false)
      expect(result.current.error).toBe('Could not connect this provider. Please try again.')
    },
  )

  it('always cancels in-memory authorization when storage cleanup is denied', async () => {
    const grant = Promise.withResolvers<string>()
    const start = spyOn(openrouter, 'startOpenRouterConnection').mockImplementation(() => grant.promise)
    const { result, onConnected } = setup()
    const connecting = result.current.authorize({ provider: 'openrouter', name: 'OpenRouter' })
    await act(async () => {})
    const targets = [globalThis, window]
    const originals = targets.flatMap((target) =>
      (['sessionStorage', 'localStorage'] as const).map((key) => ({
        target,
        key,
        descriptor: Object.getOwnPropertyDescriptor(target, key)!,
      })),
    )
    try {
      for (const { target, key } of originals) {
        Object.defineProperty(target, key, {
          configurable: true,
          get: () => {
            throw new DOMException('Storage denied', 'SecurityError')
          },
        })
      }
      act(() => result.current.cancel())
      expect(result.current.isPending).toBe(false)
      expect(start.mock.calls[0][0]?.signal?.aborted).toBe(true)
    } finally {
      for (const { target, key, descriptor } of originals) {
        Object.defineProperty(target, key, descriptor)
      }
    }
    await act(async () => {
      grant.resolve('late-token')
      await connecting
    })
    expect(onConnected).not.toHaveBeenCalled()
    expect(await getProviderConnections(getDb())).toEqual([])
  })
})
