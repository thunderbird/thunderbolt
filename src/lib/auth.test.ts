import { beforeAll, describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { waitForOAuthCallback } from './oauth-callback'

const postFromOrigin = (origin: string, data: unknown) => {
  window.dispatchEvent(new MessageEvent('message', { origin, data }))
}

describe('waitForOAuthCallback', () => {
  // Restore real event APIs — other test files replace them with mocks and never restore
  beforeAll(() => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const win = iframe.contentWindow!
    window.addEventListener = win.addEventListener.bind(window)
    window.removeEventListener = win.removeEventListener.bind(window)
    window.dispatchEvent = win.dispatchEvent.bind(window)
    document.body.removeChild(iframe)
  })

  it('resolves with code and state from same-origin postMessage', async () => {
    const promise = waitForOAuthCallback(null)

    postFromOrigin(window.location.origin, {
      type: 'oauth-callback',
      code: 'auth-code-123',
      state: 'state-abc',
    })

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
    postFromOrigin(window.location.origin, {
      type: 'oauth-callback',
      code: 'real-code',
      state: 'real-state',
    })

    const result = await promise
    expect(result).toEqual({ code: 'real-code', state: 'real-state' })
  })

  it('ignores postMessage with wrong type', async () => {
    const promise = waitForOAuthCallback(null)

    // Wrong type — handler should skip
    postFromOrigin(window.location.origin, {
      type: 'unrelated-event',
      code: 'wrong-type-code',
    })

    // Correct message to unblock
    postFromOrigin(window.location.origin, {
      type: 'oauth-callback',
      code: 'correct-code',
      state: 'correct-state',
    })

    const result = await promise
    expect(result).toEqual({ code: 'correct-code', state: 'correct-state' })
  })

  it('rejects when callback contains an error', async () => {
    const promise = waitForOAuthCallback(null)
    promise.catch(() => {}) // prevent unhandled rejection before handler attaches

    postFromOrigin(window.location.origin, {
      type: 'oauth-callback',
      error: 'access_denied',
    })

    await expect(promise).rejects.toThrow('access_denied')
  })

  it('rejects when callback is missing code or state', async () => {
    const promise = waitForOAuthCallback(null)
    promise.catch(() => {}) // prevent unhandled rejection before handler attaches

    postFromOrigin(window.location.origin, {
      type: 'oauth-callback',
    })

    await expect(promise).rejects.toThrow('Invalid OAuth callback: missing code or state')
  })

  it('closes the popup after receiving callback', async () => {
    let closed = false
    const popup = { closed: false, close: () => (closed = true) } as unknown as Window

    const promise = waitForOAuthCallback(popup)

    postFromOrigin(window.location.origin, {
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

    const promise = waitForOAuthCallback(popup)

    postFromOrigin(window.location.origin, {
      type: 'oauth-callback',
      code: 'code',
      state: 'state',
    })

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
