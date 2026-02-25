import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

// --- Mock all external dependencies before importing the module under test ---

let mockStartImpl: () => Promise<number> = async () => 17421
let mockCancelImpl: (port: number) => Promise<void> = async () => {}
let mockOnUrlImpl: (cb: (url: string) => void) => Promise<() => void> = async () => () => {}
let mockOpenUrlImpl: (url: string) => Promise<void> = async () => {}
let mockBuildAuthUrlImpl: () => Promise<string> = async () => 'https://accounts.google.com/o/oauth2/v2/auth?state=test'
let mockExchangeCodeForTokensImpl: () => Promise<object> = async () => ({
  access_token: 'access_token',
  refresh_token: 'refresh_token',
  expires_in: 3600,
  token_type: 'Bearer',
})
let mockGetUserInfoImpl: () => Promise<object> = async () => ({
  id: '123',
  email: 'test@example.com',
  name: 'Test User',
  verified_email: true,
})

mock.module('@fabianlars/tauri-plugin-oauth', () => ({
  start: (opts: object) => mockStartImpl(),
  cancel: (port: number) => mockCancelImpl(port),
  onUrl: (cb: (url: string) => void) => mockOnUrlImpl(cb),
}))

mock.module('@tauri-apps/plugin-opener', () => ({
  openUrl: (url: string) => mockOpenUrlImpl(url),
}))

mock.module('./auth', () => ({
  buildAuthUrl: () => mockBuildAuthUrlImpl(),
  exchangeCodeForTokens: () => mockExchangeCodeForTokensImpl(),
  getUserInfo: () => mockGetUserInfoImpl(),
}))

mock.module('./pkce', () => ({
  generateCodeVerifier: () => 'mock_verifier',
  generateCodeChallenge: async () => 'mock_challenge',
}))

mock.module('uuid', () => ({
  v4: () => 'mock-state-uuid',
}))

// Import module AFTER mocks are registered
const { startOAuthFlowLoopback } = await import('./oauth-loopback')

describe('startOAuthFlowLoopback', () => {
  let cancelSpy: ReturnType<typeof spyOn>
  let unlistenFn: ReturnType<typeof mock>

  beforeEach(() => {
    // Reset to defaults
    unlistenFn = mock()
    mockStartImpl = async () => 17421
    mockCancelImpl = async () => {}
    mockOpenUrlImpl = async () => {}
    mockBuildAuthUrlImpl = async () => 'https://accounts.google.com/o/oauth2/v2/auth?state=mock-state-uuid'
    mockExchangeCodeForTokensImpl = async () => ({
      access_token: 'access_token',
      refresh_token: 'refresh_token',
      expires_in: 3600,
      token_type: 'Bearer',
    })
    mockGetUserInfoImpl = async () => ({
      id: '123',
      email: 'test@example.com',
      name: 'Test User',
      verified_email: true,
    })
  })

  it('happy path: returns tokens and userInfo on successful OAuth callback', async () => {
    mockOnUrlImpl = async (cb) => {
      // Simulate browser redirect with valid code and matching state
      queueMicrotask(() => cb('http://localhost:17421?code=auth_code&state=mock-state-uuid'))
      return unlistenFn
    }

    const result = await startOAuthFlowLoopback('google')

    expect(result).not.toBeNull()
    expect(result?.tokens.access_token).toBe('access_token')
    expect(result?.userInfo.email).toBe('test@example.com')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('Google error: throws when callback URL contains error_description', async () => {
    mockOnUrlImpl = async (cb) => {
      queueMicrotask(() =>
        cb('http://localhost:17421?error=access_denied&error_description=User+denied+access'),
      )
      return unlistenFn
    }

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow('User denied access')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('state mismatch: throws when returned state does not match generated state', async () => {
    mockOnUrlImpl = async (cb) => {
      queueMicrotask(() => cb('http://localhost:17421?code=auth_code&state=wrong-state'))
      return unlistenFn
    }

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow('OAuth state mismatch')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('missing code: throws when callback URL has no code parameter', async () => {
    mockOnUrlImpl = async (cb) => {
      queueMicrotask(() => cb('http://localhost:17421?state=mock-state-uuid'))
      return unlistenFn
    }

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow(
      'Missing code or state in OAuth callback',
    )
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('exchange failure: cancel still called when token exchange throws', async () => {
    mockOnUrlImpl = async (cb) => {
      queueMicrotask(() => cb('http://localhost:17421?code=auth_code&state=mock-state-uuid'))
      return unlistenFn
    }
    mockExchangeCodeForTokensImpl = async () => {
      throw new Error('Token exchange failed')
    }
    const cancelMock = mock(async (_port: number) => {})
    mockCancelImpl = cancelMock

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow('Token exchange failed')
    expect(cancelMock).toHaveBeenCalledWith(17421)
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('timeout: returns null when browser is not redirected within timeout', async () => {
    // onUrl callback never fires — simulates user abandoning browser
    mockOnUrlImpl = async (_cb) => unlistenFn

    // Patch setTimeout to fire immediately for the timeout branch
    const originalSetTimeout = globalThis.setTimeout
    let timeoutCallback: (() => void) | null = null
    // @ts-expect-error patching global for test
    globalThis.setTimeout = (fn: () => void, _ms: number) => {
      timeoutCallback = fn
      return 0
    }

    const promise = startOAuthFlowLoopback('google')

    // Trigger the timeout
    await new Promise((resolve) => queueMicrotask(resolve))
    timeoutCallback?.()

    const result = await promise
    expect(result).toBeNull()
    expect(unlistenFn).toHaveBeenCalledTimes(1)

    // Restore
    globalThis.setTimeout = originalSetTimeout
  })

  it('cleanup on success: cancel and unlisten are both called after successful flow', async () => {
    const cancelMock = mock(async (_port: number) => {})
    mockCancelImpl = cancelMock
    mockOnUrlImpl = async (cb) => {
      queueMicrotask(() => cb('http://localhost:17421?code=auth_code&state=mock-state-uuid'))
      return unlistenFn
    }

    await startOAuthFlowLoopback('google')

    expect(unlistenFn).toHaveBeenCalledTimes(1)
    expect(cancelMock).toHaveBeenCalledWith(17421)
  })
})
