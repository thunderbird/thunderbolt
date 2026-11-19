/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as google from '@/integrations/google/auth'
import * as microsoft from '@/integrations/microsoft/auth'
import { createMockHttpClient } from '@/test-utils/http-client'
import { clearIdentityScopedMemory } from './identity-memory'
import { getOAuthState } from './oauth-state'
import { redirectOAuthFlow } from './auth'
import { getClock } from '@/testing-library'
import { waitForOAuthCallback } from './oauth-callback'

const origin = 'http://localhost:1420'

it.each(['google', 'microsoft'] as const)(
  'does not restore %s PKCE or navigate after identity teardown interrupts authorization preparation',
  async (provider) => {
    const requested = Promise.withResolvers<void>()
    const authorization = Promise.withResolvers<string>()
    const build = spyOn(provider === 'google' ? google : microsoft, 'buildAuthUrl').mockImplementation(() => {
      requested.resolve()
      return authorization.promise
    })
    const assign = spyOn(window.location, 'assign').mockImplementation(() => {})
    try {
      const client = createMockHttpClient()
      const pending = redirectOAuthFlow(client, provider).catch((error: unknown) => error)
      await requested.promise
      clearIdentityScopedMemory()
      authorization.resolve('https://provider.example/authorize')
      expect(await pending).toHaveProperty('name', 'AbortError')
      expect(getOAuthState().state).toBeNull()
      expect(assign).not.toHaveBeenCalled()

      build.mockResolvedValue('https://provider.example/new-identity')
      await expect(redirectOAuthFlow(client, provider)).rejects.toThrow('Redirecting for OAuth')
      expect(getOAuthState()).toMatchObject({ provider, verifier: expect.any(String), state: expect.any(String) })
      expect(assign).toHaveBeenCalledWith('https://provider.example/new-identity')
    } finally {
      build.mockRestore()
      assign.mockRestore()
      clearIdentityScopedMemory()
    }
  },
)

describe('waitForOAuthCallback', () => {
  let target: EventTarget
  const originalLocation = window.location

  beforeEach(() => {
    target = new EventTarget()
    // Other test files replace window.location with partial mocks and never restore.
    // We need a real origin for the handler's origin check.
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, origin },
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      configurable: true,
      writable: true,
    })
  })

  const post = (origin: string, data: unknown) => {
    target.dispatchEvent(new MessageEvent('message', { origin, data }))
  }

  it('resolves with code and state from same-origin postMessage', async () => {
    const promise = waitForOAuthCallback(null, target)

    post(origin, {
      type: 'oauth-callback',
      code: 'auth-code-123',
      state: 'state-abc',
    })

    const result = await promise
    expect(result).toEqual({ code: 'auth-code-123', state: 'state-abc' })
  })

  it('ignores postMessage from a different origin', async () => {
    const promise = waitForOAuthCallback(null, target)

    // Cross-origin message — should be silently dropped
    post('https://evil.com', {
      type: 'oauth-callback',
      code: 'stolen-code',
      state: 'stolen-state',
    })

    // Legitimate message to unblock
    post(origin, {
      type: 'oauth-callback',
      code: 'real-code',
      state: 'real-state',
    })

    const result = await promise
    expect(result).toEqual({ code: 'real-code', state: 'real-state' })
  })

  it('ignores postMessage with wrong type', async () => {
    const promise = waitForOAuthCallback(null, target)

    // Wrong type — handler should skip
    post(origin, {
      type: 'unrelated-event',
      code: 'wrong-type-code',
    })

    // Correct message to unblock
    post(origin, {
      type: 'oauth-callback',
      code: 'correct-code',
      state: 'correct-state',
    })

    const result = await promise
    expect(result).toEqual({ code: 'correct-code', state: 'correct-state' })
  })

  it('rejects when callback contains an error', async () => {
    const promise = waitForOAuthCallback(null, target)
    promise.catch(() => {}) // prevent unhandled rejection before handler attaches

    post(origin, {
      type: 'oauth-callback',
      error: 'access_denied',
    })

    await expect(promise).rejects.toThrow('access_denied')
  })

  it('rejects when callback is missing code or state', async () => {
    const promise = waitForOAuthCallback(null, target)
    promise.catch(() => {}) // prevent unhandled rejection before handler attaches

    post(origin, {
      type: 'oauth-callback',
    })

    await expect(promise).rejects.toThrow('Invalid OAuth callback: missing code or state')
  })

  it('closes the popup after receiving callback', async () => {
    let closed = false
    const popup = { closed: false, close: () => (closed = true) } as unknown as Window

    const promise = waitForOAuthCallback(popup, target)

    post(origin, {
      type: 'oauth-callback',
      code: 'code',
      state: 'state',
    })

    await promise
    expect(closed).toBe(true)
  })

  it('does not close an already-closed popup', async () => {
    let closeCalled = false
    const popup = { closed: true, close: () => (closeCalled = true) } as unknown as Window

    const promise = waitForOAuthCallback(popup, target)

    post(origin, {
      type: 'oauth-callback',
      code: 'code',
      state: 'state',
    })

    await promise
    expect(closeCalled).toBe(false)
  })

  it('times out after 10 minutes', async () => {
    const promise = waitForOAuthCallback(null, target)
    promise.catch(() => {}) // prevent unhandled rejection before handler attaches

    await getClock().tickAsync(10 * 60 * 1000)
    await expect(promise).rejects.toThrow('OAuth timeout - please try again')
  })
})
