import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { waitForOAuthCallback } from './oauth-callback'

const origin = 'http://localhost:1420'

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
