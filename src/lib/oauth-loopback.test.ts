import { beforeEach, describe, expect, it, mock } from 'bun:test'

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE importing the module under test
// ---------------------------------------------------------------------------

let onUrlCallback: ((url: string) => void) | undefined

const mockStart = mock(() => Promise.resolve(17421))
const mockCancel = mock(() => Promise.resolve())
const mockOnUrl = mock((cb: (url: string) => void) => {
  onUrlCallback = cb
  return Promise.resolve(() => {})
})

mock.module('@fabianlars/tauri-plugin-oauth', () => ({
  start: mockStart,
  cancel: mockCancel,
  onUrl: mockOnUrl,
}))

const mockOpenUrl = mock(() => Promise.resolve())

mock.module('@tauri-apps/plugin-opener', () => ({
  openUrl: mockOpenUrl,
}))

const mockBuildAuthUrl = mock(() => Promise.resolve('https://accounts.google.com/auth?mock=1'))
const mockExchangeCodeForTokens = mock(() =>
  Promise.resolve({
    access_token: 'access-token-abc',
    refresh_token: 'refresh-token-xyz',
    expires_in: 3600,
    token_type: 'Bearer',
  }),
)
const mockGetUserInfo = mock(() =>
  Promise.resolve({
    id: 'user-123',
    email: 'user@example.com',
    name: 'Test User',
    picture: 'https://example.com/photo.jpg',
    verified_email: true,
  }),
)

mock.module('./auth', () => ({
  buildAuthUrl: mockBuildAuthUrl,
  exchangeCodeForTokens: mockExchangeCodeForTokens,
  getUserInfo: mockGetUserInfo,
}))

const mockGenerateCodeVerifier = mock(() => 'mock-code-verifier')
const mockGenerateCodeChallenge = mock(() => Promise.resolve('mock-code-challenge'))

mock.module('./pkce', () => ({
  generateCodeVerifier: mockGenerateCodeVerifier,
  generateCodeChallenge: mockGenerateCodeChallenge,
}))

const mockUuidV4 = mock(() => 'mock-state-uuid')

mock.module('uuid', () => ({
  v4: mockUuidV4,
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER all mock.module calls
// ---------------------------------------------------------------------------

import { startOAuthFlowLoopback } from './oauth-loopback'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validCallbackUrl = 'http://localhost:17421?code=auth-code-123&state=mock-state-uuid'

const simulateRedirect = (callbackUrl: string) => {
  mockOpenUrl.mockImplementation(() => {
    queueMicrotask(() => onUrlCallback?.(callbackUrl))
    return Promise.resolve()
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startOAuthFlowLoopback', () => {
  beforeEach(() => {
    onUrlCallback = undefined
    mockStart.mockClear()
    mockCancel.mockClear()
    mockOnUrl.mockClear()
    mockOpenUrl.mockClear()
    mockBuildAuthUrl.mockClear()
    mockExchangeCodeForTokens.mockClear()
    mockGetUserInfo.mockClear()

    // Restore default implementations
    mockStart.mockImplementation(() => Promise.resolve(17421))
    mockCancel.mockImplementation(() => Promise.resolve())
    mockOnUrl.mockImplementation((cb: (url: string) => void) => {
      onUrlCallback = cb
      return Promise.resolve(() => {})
    })
    mockBuildAuthUrl.mockImplementation(() => Promise.resolve('https://accounts.google.com/auth?mock=1'))
    mockExchangeCodeForTokens.mockImplementation(() =>
      Promise.resolve({
        access_token: 'access-token-abc',
        refresh_token: 'refresh-token-xyz',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    )
    mockGetUserInfo.mockImplementation(() =>
      Promise.resolve({
        id: 'user-123',
        email: 'user@example.com',
        name: 'Test User',
        picture: 'https://example.com/photo.jpg',
        verified_email: true,
      }),
    )
    simulateRedirect(validCallbackUrl)
  })

  it('happy path: returns tokens and userInfo on success', async () => {
    const result = await startOAuthFlowLoopback('google')

    expect(result).not.toBeNull()
    expect(result!.tokens.access_token).toBe('access-token-abc')
    expect(result!.userInfo.email).toBe('user@example.com')

    expect(mockStart).toHaveBeenCalledWith({ ports: [17421, 17422, 17423], response: expect.any(String) })
    expect(mockBuildAuthUrl).toHaveBeenCalledWith(
      'google',
      'mock-state-uuid',
      'mock-code-challenge',
      'http://localhost:17421',
    )
    expect(mockExchangeCodeForTokens).toHaveBeenCalledWith(
      'google',
      'auth-code-123',
      'mock-code-verifier',
      'http://localhost:17421',
    )
    expect(mockGetUserInfo).toHaveBeenCalledWith('google', 'access-token-abc')
    expect(mockCancel).toHaveBeenCalledWith(17421)
  })

  it('throws when callback URL contains error_description param', async () => {
    simulateRedirect('http://localhost:17421?error=access_denied&error_description=User+cancelled+the+flow')

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow('User cancelled the flow')
    expect(mockCancel).toHaveBeenCalledWith(17421)
  })

  it('throws "OAuth state mismatch" when state param does not match', async () => {
    simulateRedirect('http://localhost:17421?code=auth-code-123&state=wrong-state-value')

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow('OAuth state mismatch')
    expect(mockCancel).toHaveBeenCalledWith(17421)
  })

  it('throws "Missing code or state" when callback URL has neither param', async () => {
    simulateRedirect('http://localhost:17421')

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow('Missing code or state in OAuth callback')
    expect(mockCancel).toHaveBeenCalledWith(17421)
  })

  it('throws exchange error and still calls cancel() via finally block', async () => {
    mockExchangeCodeForTokens.mockImplementation(() => Promise.reject(new Error('Token exchange failed')))

    await expect(startOAuthFlowLoopback('google')).rejects.toThrow('Token exchange failed')
    expect(mockCancel).toHaveBeenCalledWith(17421)
  })

  it('returns null when the auth flow times out', async () => {
    // Never fire the callback — the timeout will resolve the race
    mockOpenUrl.mockImplementation(() => Promise.resolve())

    // Override the timeout to something immediate by monkeypatching setTimeout
    const originalSetTimeout = globalThis.setTimeout
    // @ts-expect-error — replacing with immediate-fire for test
    globalThis.setTimeout = (fn: () => void) => {
      // Schedule via queueMicrotask so it runs after the Promise.race is set up
      queueMicrotask(fn)
      return 0
    }

    try {
      const result = await startOAuthFlowLoopback('google')
      expect(result).toBeNull()
      expect(mockCancel).toHaveBeenCalledWith(17421)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('always calls cancel(port) and unlisten() even on success', async () => {
    const mockUnlisten = mock(() => {})
    mockOnUrl.mockImplementation((cb: (url: string) => void) => {
      onUrlCallback = cb
      return Promise.resolve(mockUnlisten)
    })

    simulateRedirect(validCallbackUrl)

    const result = await startOAuthFlowLoopback('google')

    expect(result).not.toBeNull()
    expect(mockCancel).toHaveBeenCalledWith(17421)
    expect(mockUnlisten).toHaveBeenCalledTimes(1)
  })
})
