/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { BrowserRouter, MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { clearMcpOAuthState, setMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import { clearOAuthState, setOAuthState, type ReturnContext } from '@/lib/oauth-state'
import { clearOtariBrowserReturn, getOtariBrowserReturn } from '@/lib/otari-browser-auth'
import { getClock } from '@/testing-library'
import {
  cancelTinfoilMobileConnection,
  clearTinfoilMobileReturn,
  startTinfoilMobileConnection,
} from '@/lib/tinfoil-mobile-auth'
import { mobileOAuthRedirectUri } from '@/lib/oauth-redirect'
import { providerAuthorizationDraftKey, providerAuthorizationDraftStorage } from '@/providers/authorization-draft'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import {
  determineNavigationTarget,
  parseOAuthCallback,
  parseVerifyLinkCallback,
  useDeepLinkListener,
} from './use-deep-link-listener'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

// Both OAuth flow slots live in localStorage; clear them between tests so a
// nonce set by one routing test can't leak into another.
afterEach(() => {
  clearMcpOAuthState()
  clearOAuthState()
  providerAuthorizationDraftStorage().removeItem(providerAuthorizationDraftKey)
  cancelTinfoilMobileConnection()
  localStorage.removeItem('thunderbolt.otari.authorization')
  clearOtariBrowserReturn('o'.repeat(43))
})

const wrapper = ({ children }: { children: ReactNode }) => {
  const queryWrapper = createQueryTestWrapper()
  return createElement(BrowserRouter, null, createElement(queryWrapper, null, children))
}

describe('parseOAuthCallback', () => {
  it('parses valid OAuth callback URL with code and state', () => {
    const url = new URL('https://app.thunderbolt.io/oauth/callback?code=abc123&state=xyz789')
    const result = parseOAuthCallback(url)

    expect(result).toEqual({
      code: 'abc123',
      state: 'xyz789',
      error: null,
      iss: null,
    })
  })

  it('forwards the RFC 9207 iss parameter when present', () => {
    const url = new URL(
      'https://app.thunderbolt.io/oauth/callback?code=abc123&state=xyz789&iss=https%3A%2F%2Fauth.example.com',
    )
    const result = parseOAuthCallback(url)

    expect(result).toEqual({
      code: 'abc123',
      state: 'xyz789',
      error: null,
      iss: 'https://auth.example.com',
    })
  })

  it('parses OAuth callback URL with error parameter', () => {
    const url = new URL('https://app.thunderbolt.io/oauth/callback?error=access_denied')
    const result = parseOAuthCallback(url)

    expect(result).toEqual({
      code: null,
      state: null,
      error: 'access_denied',
      iss: null,
    })
  })

  it('prioritizes error_description over error parameter', () => {
    const url = new URL(
      'https://app.thunderbolt.io/oauth/callback?error=access_denied&error_description=User%20cancelled',
    )
    const result = parseOAuthCallback(url)

    expect(result).toEqual({
      code: null,
      state: null,
      error: 'User cancelled',
      iss: null,
    })
  })

  it('handles OAuth callback URL with missing parameters', () => {
    const url = new URL('https://app.thunderbolt.io/oauth/callback')
    const result = parseOAuthCallback(url)

    expect(result).toEqual({
      code: null,
      state: null,
      error: null,
      iss: null,
    })
  })

  it('handles OAuth callback URL with nested path', () => {
    const url = new URL('https://app.thunderbolt.io/oauth/callback/extra?code=abc123&state=xyz789')
    const result = parseOAuthCallback(url)

    expect(result).toEqual({
      code: 'abc123',
      state: 'xyz789',
      error: null,
      iss: null,
    })
  })

  it('returns null for wrong hostname', () => {
    const url = new URL('https://evil.com/oauth/callback?code=abc123&state=xyz789')
    const result = parseOAuthCallback(url)

    expect(result).toBeNull()
  })

  it('returns null for wrong path', () => {
    const url = new URL('https://app.thunderbolt.io/different/path?code=abc123&state=xyz789')
    const result = parseOAuthCallback(url)

    expect(result).toBeNull()
  })

  it('returns null for non-OAuth URL', () => {
    const url = new URL('https://app.thunderbolt.io/')
    const result = parseOAuthCallback(url)

    expect(result).toBeNull()
  })
})

describe('parseVerifyLinkCallback', () => {
  it('parses valid verify link callback URL with email and otp', () => {
    const url = new URL('https://app.thunderbolt.io/auth/verify?email=user%40example.com&otp=123456')
    const result = parseVerifyLinkCallback(url)

    expect(result).toEqual({
      email: 'user@example.com',
      otp: '123456',
      challengeToken: undefined,
    })
  })

  it('handles verify link URL with nested path', () => {
    const url = new URL('https://app.thunderbolt.io/auth/verify/extra?email=user%40example.com&otp=123456')
    const result = parseVerifyLinkCallback(url)

    expect(result).toEqual({
      email: 'user@example.com',
      otp: '123456',
      challengeToken: undefined,
    })
  })

  it('returns null when email is missing', () => {
    const url = new URL('https://app.thunderbolt.io/auth/verify?otp=123456')
    const result = parseVerifyLinkCallback(url)

    expect(result).toBeNull()
  })

  it('returns null when otp is missing', () => {
    const url = new URL('https://app.thunderbolt.io/auth/verify?email=user%40example.com')
    const result = parseVerifyLinkCallback(url)

    expect(result).toBeNull()
  })

  it('returns null when both params are missing', () => {
    const url = new URL('https://app.thunderbolt.io/auth/verify')
    const result = parseVerifyLinkCallback(url)

    expect(result).toBeNull()
  })

  it('returns null for wrong hostname', () => {
    const url = new URL('https://evil.com/auth/verify?email=user%40example.com&otp=123456')
    const result = parseVerifyLinkCallback(url)

    expect(result).toBeNull()
  })

  it('returns null for wrong path', () => {
    const url = new URL('https://app.thunderbolt.io/different/path?email=user%40example.com&otp=123456')
    const result = parseVerifyLinkCallback(url)

    expect(result).toBeNull()
  })

  it('returns null for OAuth callback URL', () => {
    const url = new URL('https://app.thunderbolt.io/oauth/callback?code=abc&state=xyz')
    const result = parseVerifyLinkCallback(url)

    expect(result).toBeNull()
  })

  it('handles email with special characters', () => {
    const url = new URL('https://app.thunderbolt.io/auth/verify?email=user%2Btag%40example.com&otp=123456')
    const result = parseVerifyLinkCallback(url)

    expect(result).toEqual({
      email: 'user+tag@example.com',
      otp: '123456',
      challengeToken: undefined,
    })
  })

  it('parses challengeToken when present', () => {
    const url = new URL(
      'https://app.thunderbolt.io/auth/verify?email=user%40example.com&otp=12345678&challengeToken=abc-123-def',
    )
    const result = parseVerifyLinkCallback(url)

    expect(result).toEqual({
      email: 'user@example.com',
      otp: '12345678',
      challengeToken: 'abc-123-def',
    })
  })

  it('returns undefined challengeToken when not present', () => {
    const url = new URL('https://app.thunderbolt.io/auth/verify?email=user%40example.com&otp=12345678')
    const result = parseVerifyLinkCallback(url)

    expect(result).toEqual({
      email: 'user@example.com',
      otp: '12345678',
      challengeToken: undefined,
    })
  })
})

describe('determineNavigationTarget', () => {
  const mockOAuthData = {
    code: 'abc123',
    state: 'xyz789',
    error: null,
    iss: null,
  }

  it('navigates to absolute path when returnContext starts with /', () => {
    const result = determineNavigationTarget('/chats/123', mockOAuthData)

    expect(result).toEqual({
      path: '/chats/123',
      oauth: mockOAuthData,
    })
  })

  it('navigates to chat detail page', () => {
    const result = determineNavigationTarget('/chats/abc-def-ghi', mockOAuthData)

    expect(result).toEqual({
      path: '/chats/abc-def-ghi',
      oauth: mockOAuthData,
    })
  })

  it('navigates to /chats/new when returnContext is "onboarding"', () => {
    const result = determineNavigationTarget('onboarding', mockOAuthData)

    expect(result).toEqual({
      path: '/chats/new',
      oauth: mockOAuthData,
    })
  })

  it('navigates to the connections page when returnContext is "integrations"', () => {
    const result = determineNavigationTarget('integrations', mockOAuthData)

    expect(result).toEqual({
      path: '/settings/connections',
      oauth: mockOAuthData,
    })
  })

  it('defaults to the connections page when returnContext is null', () => {
    const result = determineNavigationTarget(null, mockOAuthData)

    expect(result).toEqual({
      path: '/settings/connections',
      oauth: mockOAuthData,
    })
  })

  it('defaults to the connections page when returnContext is empty string', () => {
    const result = determineNavigationTarget('' as unknown as ReturnContext, mockOAuthData)

    expect(result).toEqual({
      path: '/settings/connections',
      oauth: mockOAuthData,
    })
  })

  it('defaults to the connections page when returnContext is undefined', () => {
    const result = determineNavigationTarget(undefined as unknown as ReturnContext, mockOAuthData)

    expect(result).toEqual({
      path: '/settings/connections',
      oauth: mockOAuthData,
    })
  })

  it('navigates to settings pages', () => {
    const result = determineNavigationTarget('/settings/preferences', mockOAuthData)

    expect(result).toEqual({
      path: '/settings/preferences',
      oauth: mockOAuthData,
    })
  })

  it('preserves OAuth error in navigation target', () => {
    const oauthWithError = {
      code: null,
      state: null,
      error: 'access_denied',
      iss: null,
    }

    const result = determineNavigationTarget('/chats/123', oauthWithError)

    expect(result).toEqual({
      path: '/chats/123',
      oauth: oauthWithError,
    })
  })

  it('rejects protocol-relative URLs starting with //', () => {
    const result = determineNavigationTarget('//evil.com' as ReturnContext, mockOAuthData)

    expect(result).toEqual({
      path: '/settings/connections',
      oauth: mockOAuthData,
    })
  })

  it('handles relative-looking paths that do not start with /', () => {
    const result = determineNavigationTarget('chats/123' as unknown as ReturnContext, mockOAuthData)

    expect(result).toEqual({
      path: '/settings/connections',
      oauth: mockOAuthData,
    })
  })

  it('routes an MCP callback (matching handshake nonce) to the connections page', () => {
    // Even though the shared return-context slot points at integrations, a callback
    // whose state matches the pending MCP handshake belongs to the MCP flow.
    setMcpOAuthState({ serverId: 'server-1', stateNonce: 'xyz789', startedAt: Date.now() })

    const result = determineNavigationTarget('integrations', mockOAuthData)

    expect(result).toEqual({
      path: '/settings/connections',
      oauth: mockOAuthData,
    })
  })

  it('does not hijack an integrations callback whose state does not match the MCP handshake', () => {
    // Security invariant: a callback carrying a code is only claimed by exact nonce match.
    setMcpOAuthState({ serverId: 'server-1', stateNonce: 'a-different-nonce', startedAt: Date.now() })

    const result = determineNavigationTarget('integrations', mockOAuthData)

    expect(result).toEqual({
      path: '/settings/connections',
      oauth: mockOAuthData,
    })
  })

  it('routes a stateless error callback to the MCP page while an MCP handshake is pending', () => {
    // A non-compliant AS may omit `state` on the error redirect; the pending
    // handshake must still be claimed (and cleared by the MCP page) or it would
    // block other servers' authorizations until the abandoned-flow window lapses.
    setMcpOAuthState({ serverId: 'server-1', stateNonce: 'nonce-xyz', startedAt: Date.now() })
    const errorCallback = { code: null, state: null, error: 'access_denied', iss: null }

    const result = determineNavigationTarget('integrations', errorCallback)

    expect(result).toEqual({
      path: '/settings/connections',
      oauth: errorCallback,
    })
  })

  it('routes a stateless error callback to integrations when no MCP handshake is pending', () => {
    const errorCallback = { code: null, state: null, error: 'access_denied', iss: null }

    const result = determineNavigationTarget('integrations', errorCallback)

    expect(result).toEqual({
      path: '/settings/connections',
      oauth: errorCallback,
    })
  })

  it('routes an error callback belonging to the pending integrations flow to integrations', () => {
    setMcpOAuthState({ serverId: 'server-1', stateNonce: 'nonce-xyz', startedAt: Date.now() })
    setOAuthState({ state: 'integrations-nonce' })
    const errorCallback = { code: null, state: 'integrations-nonce', error: 'access_denied', iss: null }

    const result = determineNavigationTarget('integrations', errorCallback)

    expect(result).toEqual({
      path: '/settings/connections',
      oauth: errorCallback,
    })
  })
})

describe('parseOAuthCallback + determineNavigationTarget integration', () => {
  it('handles complete OAuth success flow', () => {
    const url = new URL('https://app.thunderbolt.io/oauth/callback?code=abc123&state=xyz789')
    const oauthData = parseOAuthCallback(url)

    expect(oauthData).not.toBeNull()

    const target = determineNavigationTarget('/chats/test-chat', oauthData!)

    expect(target).toEqual({
      path: '/chats/test-chat',
      oauth: {
        code: 'abc123',
        state: 'xyz789',
        error: null,
        iss: null,
      },
    })
  })

  it('handles complete OAuth error flow', () => {
    const url = new URL(
      'https://app.thunderbolt.io/oauth/callback?error=access_denied&error_description=User%20cancelled%20authorization',
    )
    const oauthData = parseOAuthCallback(url)

    expect(oauthData).not.toBeNull()

    const target = determineNavigationTarget('integrations', oauthData!)

    expect(target).toEqual({
      path: '/settings/connections',
      oauth: {
        code: null,
        state: null,
        error: 'User cancelled authorization',
        iss: null,
      },
    })
  })
})

describe('useDeepLinkListener hook', () => {
  it('handles an integration callback once when startup and the native event deliver the same state', async () => {
    const url = `${mobileOAuthRedirectUri}?code=private-code&state=integration-state`
    let deliver!: (urls: string[]) => void
    const { unmount, result } = renderHook(
      () => {
        useDeepLinkListener(undefined, {
          isTauri: () => true,
          onOpenUrl: async (listener) => {
            deliver = listener
            listener([url])
            return () => {}
          },
          getCurrent: async () => [url],
        })
        return { location: useLocation(), navigate: useNavigate() }
      },
      { wrapper: ({ children }: { children: ReactNode }) => createElement(MemoryRouter, null, children) },
    )
    await act(async () => getClock().runAllAsync())
    expect(result.current.location.pathname).toBe('/settings/connections')
    act(() => result.current.navigate('/chats/new'))
    await act(async () => deliver([url]))
    expect(result.current.location.pathname).toBe('/chats/new')
    unmount()
  })

  it('routes Tinfoil before integrations and ignores duplicate native delivery after setup consumes the handoff', async () => {
    const nonce = 'n'.repeat(43)
    await startTinfoilMobileConnection(
      'connections',
      { provider: 'tinfoil', revision: 'initial' },
      new AbortController().signal,
      {
        verifier: () => nonce,
        challenge: async () => 'challenge',
        openUrl: async () => {},
      },
    )
    const url = `${mobileOAuthRedirectUri}?code=private-code&state=${nonce}`
    let deliver!: (urls: string[]) => void
    const { unmount, result } = renderHook(
      () => {
        useDeepLinkListener(undefined, {
          isTauri: () => true,
          onOpenUrl: async (listener) => {
            deliver = listener
            return () => {}
          },
          getCurrent: async () => [url],
        })
        return { location: useLocation(), navigate: useNavigate() }
      },
      { wrapper: ({ children }: { children: ReactNode }) => createElement(MemoryRouter, null, children) },
    )
    await act(async () => getClock().runAllAsync())
    expect(result.current.location.pathname).toBe('/oauth/tinfoil')
    clearTinfoilMobileReturn(nonce)
    act(() => result.current.navigate('/settings/connections'))
    await act(async () => deliver([url]))
    expect(result.current.location.pathname).toBe('/settings/connections')
    unmount()
  })

  it('cleans up a listener that finishes registering after unmount', async () => {
    const registration = Promise.withResolvers<() => void>()
    const remove = mock(() => {})
    const getCurrent = mock(async () => null)
    const { unmount } = renderHook(
      () =>
        useDeepLinkListener(undefined, {
          isTauri: () => true,
          onOpenUrl: () => registration.promise,
          getCurrent,
        }),
      { wrapper },
    )
    unmount()
    await act(async () => registration.resolve(remove))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(getCurrent).not.toHaveBeenCalled()
  })

  it('never logs callback URLs or authorization codes on failure', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { unmount } = renderHook(
        () =>
          useDeepLinkListener(undefined, {
            isTauri: () => true,
            onOpenUrl: async () => () => {},
            getCurrent: async () => ['invalid?code=private-code&state=private-state'],
          }),
        { wrapper },
      )
      await act(async () => getClock().runAllAsync())
      expect(log).toHaveBeenCalledWith('Failed to handle deep link')
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-')
      unmount()
    } finally {
      log.mockRestore()
    }
  })
  it.each(['running', 'cold-start'] as const)(
    'routes Otari app links into its own return flow on %s',
    async (lifecycle) => {
      const state = 'o'.repeat(43)
      localStorage.setItem(
        'thunderbolt.otari.authorization',
        JSON.stringify({
          state,
          verifier: 'v'.repeat(43),
          origin: 'https://otari.ai',
          redirectUri: 'https://app.thunderbolt.io/oauth/callback',
          returnTo: '/settings/models',
          context: 'models',
          attempt: { provider: 'otari', revision: 'before-connect' },
          createdAt: Date.now(),
        }),
      )
      const urls = [`https://app.thunderbolt.io/oauth/callback?code=one-use&state=${state}`]
      let callback: ((urls: string[]) => void) | undefined
      const customHandler = () => {
        throw new Error('Owned callback reached custom handler')
      }
      // A concurrent Google return context must not claim Otari's nonce.
      setOAuthState({ state: 'google-nonce', provider: 'google', returnContext: '/chats/google' })
      const view = renderHook(
        () => {
          useDeepLinkListener(customHandler, {
            isTauri: () => true,
            getCurrent: async () => (lifecycle === 'cold-start' ? urls : null),
            onOpenUrl: async (handler) => {
              callback = handler
              return () => {}
            },
          })
          return { location: useLocation(), navigate: useNavigate() }
        },
        { wrapper: ({ children }) => createElement(MemoryRouter, null, children) },
      )
      await act(async () => getClock().tickAsync(0))
      if (lifecycle === 'running') {
        await act(async () => callback!(urls))
      }
      expect(view.result.current.location.pathname).toBe('/oauth/otari')
      expect(view.result.current.location.search).toBe('')
      expect(getOtariBrowserReturn('models')).toMatchObject({
        id: state,
        returnTo: '/settings/models',
        error: null,
        attempt: { provider: 'otari', revision: 'before-connect' },
      })
      expect(localStorage.getItem('thunderbolt.otari.authorization')).toBeNull()
      clearOtariBrowserReturn(state)
      act(() => view.result.current.navigate('/settings/models'))
      await act(async () => callback!(urls))
      expect(view.result.current.location.pathname).toBe('/settings/models')
      view.unmount()
    },
  )

  it('does not set up listeners when not running in Tauri', () => {
    const getCurrent = () => Promise.resolve(null)
    const onOpenUrl = () => Promise.resolve(() => {})

    renderHook(
      () =>
        useDeepLinkListener(undefined, {
          isTauri: () => false,
          getCurrent,
          onOpenUrl,
        }),
      { wrapper },
    )

    // If the hook doesn't crash, it means it correctly skipped setup
    expect(true).toBe(true)
  })

  it('handles custom handler for non-OAuth deep links', async () => {
    const mockUrls = ['https://app.thunderbolt.io/some/other/path']
    let customHandlerCalled = false
    let customHandlerUrls: string[] = []
    let callback: ((urls: string[]) => void) | null = null

    const getCurrent = () => Promise.resolve(null)
    const onOpenUrl = (cb: (urls: string[]) => void): Promise<() => Promise<void>> => {
      callback = cb
      return Promise.resolve(async () => {})
    }

    const customHandler = async (urls: string[]) => {
      customHandlerCalled = true
      customHandlerUrls = urls
    }

    renderHook(
      () =>
        useDeepLinkListener(customHandler, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
        }),
      { wrapper },
    )

    // Wait for setup
    await act(async () => {
      await getClock().runAllAsync()
    })

    // Now trigger the callback
    expect(callback).not.toBeNull()
    await act(async () => {
      callback!(mockUrls)
    })

    expect(customHandlerCalled).toBe(true)
    expect(customHandlerUrls).toEqual(mockUrls)
  })

  it('does NOT call custom handler for OAuth callback URLs', async () => {
    const mockUrls = ['https://app.thunderbolt.io/oauth/callback?code=abc123&state=xyz789']
    let customHandlerCalled = false
    let callback: ((urls: string[]) => void) | null = null

    const getCurrent = () => Promise.resolve(null)
    const onOpenUrl = (cb: (urls: string[]) => void): Promise<() => Promise<void>> => {
      callback = cb
      return Promise.resolve(async () => {})
    }
    setOAuthState({ returnContext: '/chats/test' })

    const customHandler = async (_urls: string[]) => {
      customHandlerCalled = true
    }

    renderHook(
      () =>
        useDeepLinkListener(customHandler, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
        }),
      { wrapper },
    )

    // Wait for setup
    await act(async () => {
      await getClock().runAllAsync()
    })

    // Trigger OAuth callback
    expect(callback).not.toBeNull()
    await act(async () => {
      callback!(mockUrls)
    })

    // Handler should NOT have been called for OAuth URL
    expect(customHandlerCalled).toBe(false)
  })

  it('does NOT call custom handler for verify link callback URLs', async () => {
    const mockUrls = ['https://app.thunderbolt.io/auth/verify?email=user%40example.com&otp=123456']
    let customHandlerCalled = false
    let callback: ((urls: string[]) => void) | null = null

    const getCurrent = () => Promise.resolve(null)
    const onOpenUrl = (cb: (urls: string[]) => void): Promise<() => Promise<void>> => {
      callback = cb
      return Promise.resolve(async () => {})
    }

    const customHandler = async (_urls: string[]) => {
      customHandlerCalled = true
    }

    renderHook(
      () =>
        useDeepLinkListener(customHandler, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
        }),
      { wrapper },
    )

    // Wait for setup
    await act(async () => {
      await getClock().runAllAsync()
    })

    // Trigger verify link callback
    expect(callback).not.toBeNull()
    await act(async () => {
      callback!(mockUrls)
    })

    // Handler should NOT have been called for verify link URL
    expect(customHandlerCalled).toBe(false)
  })

  it('calls custom handler only once with multiple non-OAuth URLs', async () => {
    const mockUrls = [
      'https://app.thunderbolt.io/path1',
      'https://app.thunderbolt.io/path2',
      'https://app.thunderbolt.io/path3',
    ]
    let customHandlerCallCount = 0
    let receivedUrls: string[] = []
    let callback: ((urls: string[]) => void) | null = null

    const getCurrent = () => Promise.resolve(null)
    const onOpenUrl = (cb: (urls: string[]) => void): Promise<() => Promise<void>> => {
      callback = cb
      return Promise.resolve(async () => {})
    }

    const customHandler = async (urls: string[]) => {
      customHandlerCallCount++
      receivedUrls = urls
    }

    renderHook(
      () =>
        useDeepLinkListener(customHandler, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
        }),
      { wrapper },
    )

    // Wait for setup
    await act(async () => {
      await getClock().runAllAsync()
    })

    // Trigger with multiple URLs
    expect(callback).not.toBeNull()
    await act(async () => {
      callback!(mockUrls)
    })

    // Handler should be called exactly once with all URLs
    expect(customHandlerCallCount).toBe(1)
    expect(receivedUrls).toEqual(mockUrls)
  })

  it('filters out OAuth and verify link URLs and only passes unhandled URLs to handler', async () => {
    const mockUrls = [
      'https://app.thunderbolt.io/path1',
      'https://app.thunderbolt.io/oauth/callback?code=abc123&state=xyz',
      'https://app.thunderbolt.io/auth/verify?email=user%40example.com&otp=123456',
      'https://app.thunderbolt.io/path2',
    ]
    let receivedUrls: string[] = []
    let callback: ((urls: string[]) => void) | null = null

    const getCurrent = () => Promise.resolve(null)
    const onOpenUrl = (cb: (urls: string[]) => void): Promise<() => Promise<void>> => {
      callback = cb
      return Promise.resolve(async () => {})
    }
    setOAuthState({ returnContext: '/chats/test' })

    const customHandler = async (urls: string[]) => {
      receivedUrls = urls
    }

    renderHook(
      () =>
        useDeepLinkListener(customHandler, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
        }),
      { wrapper },
    )

    // Wait for setup
    await act(async () => {
      await getClock().runAllAsync()
    })

    // Trigger with mixed URLs
    expect(callback).not.toBeNull()
    await act(async () => {
      callback!(mockUrls)
    })

    // Handler should only receive unhandled URLs (not OAuth or verify link)
    expect(receivedUrls).toEqual(['https://app.thunderbolt.io/path1', 'https://app.thunderbolt.io/path2'])
  })

  it('handles invalid URLs gracefully', async () => {
    const mockUrls = ['not-a-valid-url']

    const getCurrent = () => Promise.resolve(mockUrls)
    const onOpenUrl = () => Promise.resolve(() => {})

    // Should not throw error
    renderHook(
      () =>
        useDeepLinkListener(undefined, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
        }),
      { wrapper },
    )

    // Wait for async processing
    await act(async () => {
      await getClock().runAllAsync()
    })

    // If we get here without error, the hook handled invalid URL gracefully
    expect(true).toBe(true)
  })

  it('sets up listener for deep links while app is running', async () => {
    let storedCallback: ((urls: string[]) => void) | null = null

    const getCurrent = () => Promise.resolve(null)
    const onOpenUrl = (callback: (urls: string[]) => void): Promise<() => Promise<void>> => {
      storedCallback = callback
      return Promise.resolve(async () => {})
    }
    setOAuthState({ returnContext: '/chats/active' })

    renderHook(
      () =>
        useDeepLinkListener(undefined, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
        }),
      { wrapper },
    )

    // Wait for setup
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(storedCallback).not.toBeNull()

    // Simulate a deep link event
    expect(storedCallback).not.toBeNull()
    await act(async () => {
      storedCallback!(['https://app.thunderbolt.io/oauth/callback?code=test&state=test'])
    })
    // If no error thrown, the listener worked
    expect(true).toBe(true)
  })
})

it('restores native MCP OAuth to its originating route rather than the integration return slot', () => {
  setMcpOAuthState({
    serverId: 'oauth:exa',
    stateNonce: 'native-nonce',
    returnTo: '/chats/new?project=work#composer',
    startedAt: Date.now(),
  })
  const oauth = { code: 'code', state: 'native-nonce', error: null, iss: null }
  expect(determineNavigationTarget('integrations', oauth)).toEqual({ path: '/chats/new?project=work#composer', oauth })
  clearMcpOAuthState()
})

it.each([true, false])('routes native search OAuth back to its owning UI (onboarding: %s)', async (onboarding) => {
  setMcpOAuthState({
    serverId: 'oauth:exa',
    stateNonce: 'native-search',
    returnTo: '/chats/new',
    startedAt: Date.now(),
  })
  if (onboarding) {
    providerAuthorizationDraftStorage().setItem(
      providerAuthorizationDraftKey,
      JSON.stringify({ purpose: 'onboarding-search', provider: 'exa' }),
    )
  }
  const { result } = renderHook(
    () => {
      useDeepLinkListener(undefined, {
        isTauri: () => true,
        getCurrent: async () => ['https://app.thunderbolt.io/oauth/callback?code=test&state=native-search'],
        onOpenUrl: async () => () => {},
      })
      return useLocation()
    },
    { wrapper: ({ children }) => createElement(MemoryRouter, null, children) },
  )
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(result.current.pathname).toBe('/chats/new')
  expect(result.current.state.oauth).toMatchObject({ code: 'test', state: 'native-search' })
  expect(result.current.state.connectionOAuthReturn).toBe(onboarding ? undefined : 'native-search')
})
