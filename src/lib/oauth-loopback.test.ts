import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { createMockHttpClient } from '@/test-utils/http-client'
import * as tauriCore from '@tauri-apps/api/core'
import * as tauriEvent from '@tauri-apps/api/event'
import * as opener from '@tauri-apps/plugin-opener'
import * as auth from './auth'
import * as uuid from 'uuid'
import { startOAuthFlowLoopback } from './oauth-loopback'

const mockHttpClient = createMockHttpClient()

describe('startOAuthFlowLoopback', () => {
  let unlistenFn: ReturnType<typeof mock>
  let listenSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    unlistenFn = mock()

    spyOn(tauriCore, 'invoke').mockImplementation(async () => 17421 as never)
    listenSpy = spyOn(tauriEvent, 'listen').mockImplementation(async () => () => {})
    spyOn(opener, 'openUrl').mockImplementation(async () => {})
    spyOn(auth, 'buildAuthUrl').mockImplementation(
      async () => 'https://accounts.google.com/o/oauth2/v2/auth?state=mock-state-uuid',
    )
    spyOn(auth, 'exchangeCodeForTokens').mockImplementation(async () => ({
      access_token: 'access_token',
      refresh_token: 'refresh_token',
      expires_in: 3600,
      token_type: 'Bearer',
    }))
    spyOn(auth, 'getUserInfo').mockImplementation(async () => ({
      id: '123',
      email: 'test@example.com',
      name: 'Test User',
      verified_email: true,
    }))
    spyOn(uuid, 'v4').mockImplementation(() => 'mock-state-uuid')
  })

  afterEach(() => {
    mock.restore()
  })

  it('happy path: returns tokens and userInfo on successful OAuth callback', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421?code=auth_code&state=mock-state-uuid' } }))
      return unlistenFn
    })

    const result = await startOAuthFlowLoopback(mockHttpClient, 'google')

    expect(result).not.toBeNull()
    expect(result?.tokens.access_token).toBe('access_token')
    expect(result?.userInfo.email).toBe('test@example.com')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('Google error: throws when callback URL contains error_description', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() =>
        cb({ payload: { url: 'http://localhost:17421?error=access_denied&error_description=User+denied+access' } }),
      )
      return unlistenFn
    })

    await expect(startOAuthFlowLoopback(mockHttpClient, 'google')).rejects.toThrow('User denied access')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('state mismatch: throws when returned state does not match generated state', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421?code=auth_code&state=wrong-state' } }))
      return unlistenFn
    })

    await expect(startOAuthFlowLoopback(mockHttpClient, 'google')).rejects.toThrow('OAuth state mismatch')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('missing code: throws when callback URL has no code parameter', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421?state=mock-state-uuid' } }))
      return unlistenFn
    })

    await expect(startOAuthFlowLoopback(mockHttpClient, 'google')).rejects.toThrow(
      'Missing code or state in OAuth callback',
    )
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('exchange failure: unlisten still called when token exchange throws', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421?code=auth_code&state=mock-state-uuid' } }))
      return unlistenFn
    })
    spyOn(auth, 'exchangeCodeForTokens').mockImplementation(async () => {
      throw new Error('Token exchange failed')
    })

    await expect(startOAuthFlowLoopback(mockHttpClient, 'google')).rejects.toThrow('Token exchange failed')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('timeout: returns null when browser is not redirected within timeout', async () => {
    listenSpy.mockImplementation(async () => unlistenFn)

    const clock = getClock()
    const promise = startOAuthFlowLoopback(mockHttpClient, 'google', 1)

    await clock.tickAsync(10)

    const result = await promise
    expect(result).toBeNull()
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('cleanup on success: unlisten is called after successful flow', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421?code=auth_code&state=mock-state-uuid' } }))
      return unlistenFn
    })

    await startOAuthFlowLoopback(mockHttpClient, 'google')

    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })
})
