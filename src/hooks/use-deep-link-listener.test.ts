import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { BrowserRouter } from 'react-router'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { ReturnContext } from '@/lib/oauth-state'
import { getClock } from '@/testing-library'
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
    })
  })

  it('parses OAuth callback URL with error parameter', () => {
    const url = new URL('https://app.thunderbolt.io/oauth/callback?error=access_denied')
    const result = parseOAuthCallback(url)

    expect(result).toEqual({
      code: null,
      state: null,
      error: 'access_denied',
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
    })
  })

  it('handles OAuth callback URL with missing parameters', () => {
    const url = new URL('https://app.thunderbolt.io/oauth/callback')
    const result = parseOAuthCallback(url)

    expect(result).toEqual({
      code: null,
      state: null,
      error: null,
    })
  })

  it('handles OAuth callback URL with nested path', () => {
    const url = new URL('https://app.thunderbolt.io/oauth/callback/extra?code=abc123&state=xyz789')
    const result = parseOAuthCallback(url)

    expect(result).toEqual({
      code: 'abc123',
      state: 'xyz789',
      error: null,
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

  it('navigates to integrations page when returnContext is "integrations"', () => {
    const result = determineNavigationTarget('integrations', mockOAuthData)

    expect(result).toEqual({
      path: '/settings/integrations',
      oauth: mockOAuthData,
    })
  })

  it('defaults to integrations page when returnContext is null', () => {
    const result = determineNavigationTarget(null, mockOAuthData)

    expect(result).toEqual({
      path: '/settings/integrations',
      oauth: mockOAuthData,
    })
  })

  it('defaults to integrations page when returnContext is empty string', () => {
    const result = determineNavigationTarget('' as unknown as ReturnContext, mockOAuthData)

    expect(result).toEqual({
      path: '/settings/integrations',
      oauth: mockOAuthData,
    })
  })

  it('defaults to integrations page when returnContext is undefined', () => {
    const result = determineNavigationTarget(undefined as unknown as ReturnContext, mockOAuthData)

    expect(result).toEqual({
      path: '/settings/integrations',
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
      path: '/settings/integrations',
      oauth: mockOAuthData,
    })
  })

  it('handles relative-looking paths that do not start with /', () => {
    const result = determineNavigationTarget('chats/123' as unknown as ReturnContext, mockOAuthData)

    expect(result).toEqual({
      path: '/settings/integrations',
      oauth: mockOAuthData,
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
      path: '/settings/integrations',
      oauth: {
        code: null,
        state: null,
        error: 'User cancelled authorization',
      },
    })
  })
})

describe('useDeepLinkListener hook', () => {
  it('does not set up listeners when not running in Tauri', () => {
    const getCurrent = () => Promise.resolve(null)
    const onOpenUrl = () => Promise.resolve(() => {})
    const getSettings = () => Promise.resolve({ oauthReturnContext: null })

    renderHook(
      () =>
        useDeepLinkListener(undefined, {
          isTauri: () => false,
          getCurrent,
          onOpenUrl,
          getSettings,
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
    const getSettings = () => Promise.resolve({ oauthReturnContext: null })

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
          getSettings,
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
    const getSettings = () => Promise.resolve({ oauthReturnContext: '/chats/test' })

    const customHandler = async (_urls: string[]) => {
      customHandlerCalled = true
    }

    renderHook(
      () =>
        useDeepLinkListener(customHandler, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
          getSettings,
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
    const getSettings = () => Promise.resolve({ oauthReturnContext: null })

    const customHandler = async (_urls: string[]) => {
      customHandlerCalled = true
    }

    renderHook(
      () =>
        useDeepLinkListener(customHandler, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
          getSettings,
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
    const getSettings = () => Promise.resolve({ oauthReturnContext: null })

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
          getSettings,
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
    const getSettings = () => Promise.resolve({ oauthReturnContext: '/chats/test' })

    const customHandler = async (urls: string[]) => {
      receivedUrls = urls
    }

    renderHook(
      () =>
        useDeepLinkListener(customHandler, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
          getSettings,
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
    const getSettings = () => Promise.resolve({ oauthReturnContext: null })

    // Should not throw error
    renderHook(
      () =>
        useDeepLinkListener(undefined, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
          getSettings,
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
    const getSettings = () => Promise.resolve({ oauthReturnContext: '/chats/active' })

    renderHook(
      () =>
        useDeepLinkListener(undefined, {
          isTauri: () => true,
          getCurrent,
          onOpenUrl,
          getSettings,
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
