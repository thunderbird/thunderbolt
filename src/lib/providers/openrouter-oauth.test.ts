/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { buildOpenRouterAuthUrl, connectOpenRouterLoopback, exchangeOpenRouterCode } from './openrouter-oauth'

describe('buildOpenRouterAuthUrl', () => {
  it('includes callback_url and S256 PKCE params', () => {
    const url = new URL(buildOpenRouterAuthUrl('http://localhost:17421', 'challenge123'))
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth')
    expect(url.searchParams.get('callback_url')).toBe('http://localhost:17421')
    expect(url.searchParams.get('code_challenge')).toBe('challenge123')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })
})

describe('exchangeOpenRouterCode', () => {
  it('returns the durable key from a successful exchange', async () => {
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      expect(url.toString()).toBe('https://openrouter.ai/api/v1/auth/keys')
      const body = JSON.parse(init!.body as string)
      expect(body).toEqual({ code: 'auth-code', code_verifier: 'verifier', code_challenge_method: 'S256' })
      return new Response(JSON.stringify({ key: 'sk-or-v1-xyz' }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await exchangeOpenRouterCode('auth-code', 'verifier', fetchFn)).toBe('sk-or-v1-xyz')
  })

  it('throws on a non-ok exchange', async () => {
    const fetchFn = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch
    await expect(exchangeOpenRouterCode('c', 'v', fetchFn)).rejects.toThrow(/400/)
  })

  it('throws when no key is returned', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
    await expect(exchangeOpenRouterCode('c', 'v', fetchFn)).rejects.toThrow(/did not return an API key/)
  })
})

describe('connectOpenRouterLoopback', () => {
  it('drives the loopback → callback → key exchange happy path', async () => {
    let capturedHandler: ((url: string) => void) | undefined
    const key = await connectOpenRouterLoopback({
      startServer: async () => 17421,
      listenCallback: async (handler) => {
        capturedHandler = handler
        // Simulate the browser redirect arriving on the next tick.
        queueMicrotask(() => handler('http://localhost:17421/?code=the-code'))
        return () => {}
      },
      openUrl: async () => {},
      fetchFn: (async () =>
        new Response(JSON.stringify({ key: 'sk-or-final' }), { status: 200 })) as unknown as typeof fetch,
    })
    expect(capturedHandler).toBeDefined()
    expect(key).toBe('sk-or-final')
  })

  it('returns null on timeout', async () => {
    const promise = connectOpenRouterLoopback({
      startServer: async () => 17421,
      listenCallback: async () => () => {},
      openUrl: async () => {},
      timeoutMs: 10,
    })
    // Timers are faked globally (src/testing-library.ts) — advance to fire the timeout.
    await getClock().runAllAsync()
    expect(await promise).toBeNull()
  })

  it('propagates a provider error in the callback', async () => {
    await expect(
      connectOpenRouterLoopback({
        startServer: async () => 17421,
        listenCallback: async (handler) => {
          queueMicrotask(() => handler('http://localhost:17421/?error=access_denied'))
          return () => {}
        },
        openUrl: async () => {},
      }),
    ).rejects.toThrow(/access_denied/)
  })
})
