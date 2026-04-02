import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { waitForOAuthCallback } from './oauth-callback'

const ORIGIN = 'http://localhost:1420'

const postFromOrigin = (origin: string, data: unknown) => {
  window.dispatchEvent(new MessageEvent('message', { origin, data }))
}

describe('waitForOAuthCallback', () => {
  const originalLocation = window.location

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, origin: ORIGIN },
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

  it('resolves with code and state from same-origin postMessage', async () => {
    const promise = waitForOAuthCallback(null)

    postFromOrigin(ORIGIN, {
      type: 'oauth-callback',
      code: 'auth-code-123',
      state: 'state-abc',
    })

    await getClock().tickAsync(0)
    const result = await promise
    expect(result).toEqual({ code: 'auth-code-123', state: 'state-abc' })
  })

  it('ignores postMessage from a different origin', async () => {
    const promise = waitForOAuthCallback(null)

    // Cross-origin message — should be silently dropped
    postFromOrigin('https://evil.com', {
      type: 'oauth-callback',
      code: 'stolen-code',
      state: 'stolen-state',
    })

    // Legitimate message to unblock
    postFromOrigin(ORIGIN, {
      type: 'oauth-callback',
      code: 'real-code',
      state: 'real-state',
    })

    await getClock().tickAsync(0)
    const result = await promise
    expect(result).toEqual({ code: 'real-code', state: 'real-state' })
  })

  it('ignores postMessage with wrong type', async () => {
    const promise = waitForOAuthCallback(null)

    // Wrong type — handler should skip
    postFromOrigin(ORIGIN, {
      type: 'unrelated-event',
      code: 'wrong-type-code',
    })

    // Correct message to unblock
    postFromOrigin(ORIGIN, {
      type: 'oauth-callback',
      code: 'correct-code',
      state: 'correct-state',
    })

    await getClock().tickAsync(0)
    const result = await promise
    expect(result).toEqual({ code: 'correct-code', state: 'correct-state' })
  })

  it('rejects when callback contains an error', async () => {
    const promise = waitForOAuthCallback(null)
    promise.catch(() => {}) // prevent unhandled rejection before handler attaches

    postFromOrigin(ORIGIN, {
      type: 'oauth-callback',
      error: 'access_denied',
    })

    await getClock().tickAsync(0)
    await expect(promise).rejects.toThrow('access_denied')
  })

  it('rejects when callback is missing code or state', async () => {
    const promise = waitForOAuthCallback(null)
    promise.catch(() => {}) // prevent unhandled rejection before handler attaches

    postFromOrigin(ORIGIN, {
      type: 'oauth-callback',
    })

    await getClock().tickAsync(0)
    await expect(promise).rejects.toThrow('Invalid OAuth callback: missing code or state')
  })

  it('closes the popup after receiving callback', async () => {
    let closed = false
    const popup = { closed: false, close: () => (closed = true) } as unknown as Window

    const promise = waitForOAuthCallback(popup)

    postFromOrigin(ORIGIN, {
      type: 'oauth-callback',
      code: 'code',
      state: 'state',
    })

    await getClock().tickAsync(0)
    await promise
    expect(closed).toBe(true)
  })

  it('does not close an already-closed popup', async () => {
    let closeCalled = false
    const popup = { closed: true, close: () => (closeCalled = true) } as unknown as Window

    const promise = waitForOAuthCallback(popup)

    postFromOrigin(ORIGIN, {
      type: 'oauth-callback',
      code: 'code',
      state: 'state',
    })

    await getClock().tickAsync(0)
    await promise
    expect(closeCalled).toBe(false)
  })

  it('times out after 10 minutes', async () => {
    const promise = waitForOAuthCallback(null)
    promise.catch(() => {}) // prevent unhandled rejection before handler attaches

    await getClock().tickAsync(10 * 60 * 1000)
    await expect(promise).rejects.toThrow('OAuth timeout - please try again')
  })
})
