import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'

// --- Mock all external dependencies BEFORE importing the module under test ---

let mockInvokeImpl: () => Promise<number> = async () => 17421
let mockListenImpl: (cb: (event: { payload: { url: string } }) => void) => Promise<() => void> =
  async () => () => {}
let mockOpenUrlImpl: (url: string) => Promise<void> = async () => {}
let mockBuildAuthUrlImpl: () => Promise<string> = async () =>
  'https://accounts.google.com/o/oauth2/v2/auth?state=mock-state-uuid'
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

mock.module('@tauri-apps/api/core', () => ({
  invoke: (_cmd: string) => mockInvokeImpl(),
}))

mock.module('@tauri-apps/api/event', () => ({
  listen: (_event: string, cb: (event: { payload: { url: string } }) => void) =>
    mockListenImpl(cb),
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
  let unlistenFn: ReturnType<typeof mock>

  beforeEach(() => {
    unlistenFn = mock()
    mockInvokeImpl = async () => 17421
    mockOpenUrlImpl = async () => {}
    mockBuildAuthUrlImpl = async () =>
      'https://accounts.google.com/o/oauth2/v2/auth?state=mock-state-uuid'
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
    mockListenImpl = async (cb) => {
      // Simulate the Rust server emitting the callback event with valid code + matching state
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421?code=auth_code&state=mock-state-uuid' } }))
      return unlistenFn
    }

    const result = await startOAuthFlowLoopback('google')

    expect(result).not.toBeNull()
    expect(result?.tokens.access_token).toBe('access_token')
    expect(result?.userInfo.email).toBe('test@example.com')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('Google error: throws when callback URL contains error_description', async () => {
    mockListenImpl = async (cb) => {
      queueMicrotask(() =>
        cb({ payload: { url: 'http://localhost:17421?error=access_denied&error_description=User+denied+access' } }),
      )
      return unlistenFn
    }

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow('User denied access')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('state mismatch: throws when returned state does not match generated state', async () => {
    mockListenImpl = async (cb) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421?code=auth_code&state=wrong-state' } }))
      return unlistenFn
    }

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow('OAuth state mismatch')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('missing code: throws when callback URL has no code parameter', async () => {
    mockListenImpl = async (cb) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421?state=mock-state-uuid' } }))
      return unlistenFn
    }

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow('Missing code or state in OAuth callback')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('exchange failure: unlisten still called when token exchange throws', async () => {
    mockListenImpl = async (cb) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421?code=auth_code&state=mock-state-uuid' } }))
      return unlistenFn
    }
    mockExchangeCodeForTokensImpl = async () => {
      throw new Error('Token exchange failed')
    }

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow('Token exchange failed')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('timeout: returns null when browser is not redirected within timeout', async () => {
    // listen callback never fires — simulates user abandoning the browser window
    mockListenImpl = async (_cb) => unlistenFn

    const clock = getClock()
    const promise = startOAuthFlowLoopback('google', 1)

    // Tick past the 1ms timeout; tickAsync also drains microtasks
    await clock.tickAsync(10)

    const result = await promise
    expect(result).toBeNull()
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('cleanup on success: unlisten is called after successful flow', async () => {
    mockListenImpl = async (cb) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421?code=auth_code&state=mock-state-uuid' } }))
      return unlistenFn
    }

    await startOAuthFlowLoopback('google')

    // Rust server shuts itself down — only the TS event listener needs cleanup
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })
})
