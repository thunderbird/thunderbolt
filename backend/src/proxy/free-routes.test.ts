/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia, type AnyElysia } from 'elysia'
import { createFreeProxyRoutes } from './routes'

// Deterministic DNS resolver — 1.1.1.1 is public (passes SSRF) and stable.
const mockDnsLookup = mock(() => Promise.resolve([{ address: '1.1.1.1', family: 4 }]))

const makeOkResponse = (body = 'ok') => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })

/** Build a request to /proxy/free with the target carried in X-Proxy-Target-Url. */
const freeProxyRequest = (target: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('x-proxy-target-url', target)
  return new Request('http://localhost/proxy/free', { ...init, headers })
}

/** Drain the response body so capStream's idle timer clears. */
const drain = async (res: Response): Promise<Response> => {
  if (res.body) {
    await res.arrayBuffer()
  }
  return res
}

/** A rate-limit plugin that rejects after `max` requests, mirroring the shape of
 *  the real per-device limiter (429 + Retry-After) without a database. */
const countingRateLimit = (max: number) => {
  let count = 0
  return new Elysia()
    .onBeforeHandle(({ set }) => {
      count += 1
      if (count > max) {
        set.status = 429
        set.headers['Retry-After'] = '86400'
        return { error: 'Too many requests. Please try again later.' }
      }
    })
    .as('scoped')
}

describe('createFreeProxyRoutes', () => {
  let consoleSpies: ConsoleSpies
  let mockFetch: ReturnType<typeof mock>

  const buildApp = (opts: { rateLimit?: AnyElysia; openrouterKey?: string } = {}) =>
    new Elysia().use(
      createFreeProxyRoutes({
        openrouterKey: opts.openrouterKey ?? 'free-key-123',
        fetchFn: mockFetch as unknown as typeof fetch,
        dnsLookup: mockDnsLookup,
        rateLimit: opts.rateLimit,
      }),
    )

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
    mockFetch = mock(() => Promise.resolve(makeOkResponse()))
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(() => Promise.resolve(makeOkResponse()))
    mockDnsLookup.mockReset()
    mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '1.1.1.1', family: 4 }]))
    consoleSpies.error.mockClear()
  })

  // ---------------------------------------------------------------------------
  // No auth required
  // ---------------------------------------------------------------------------

  it('proxies without any auth token (no session, no Authorization header)', async () => {
    const app = buildApp()
    const res = await drain(
      await app.handle(
        freeProxyRequest('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' }),
      ),
    )
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------------
  // Allowlist
  // ---------------------------------------------------------------------------

  it('permits the DuckDuckGo search host', async () => {
    const app = buildApp()
    const res = await drain(await app.handle(freeProxyRequest('https://html.duckduckgo.com/html/?q=cats')))
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-allowlisted upstream with 403 and never opens a connection', async () => {
    const app = buildApp()
    const res = await drain(await app.handle(freeProxyRequest('https://evil.example.com/steal')))
    expect(res.status).toBe(403)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects a redirect that lands on a non-allowlisted host', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } })),
    )
    const app = buildApp()
    const res = await drain(await app.handle(freeProxyRequest('https://html.duckduckgo.com/html/?q=x')))
    expect(res.status).toBe(403)
    // Only the first hop opened; the redirect target was blocked before fetch.
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------------
  // Server-side key injection (model host only)
  // ---------------------------------------------------------------------------

  it('injects the hosted key as Authorization for the model host', async () => {
    const app = buildApp({ openrouterKey: 'sk-secret' })
    await drain(await app.handle(freeProxyRequest('https://openrouter.ai/api/v1/models')))
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Headers).get('authorization')).toBe('Bearer sk-secret')
  })

  it('overwrites any client-supplied Authorization for the model host', async () => {
    const app = buildApp({ openrouterKey: 'sk-secret' })
    await drain(
      await app.handle(
        freeProxyRequest('https://openrouter.ai/api/v1/models', {
          headers: { 'x-proxy-passthrough-authorization': 'Bearer client-injected' },
        }),
      ),
    )
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Headers).get('authorization')).toBe('Bearer sk-secret')
  })

  it('does NOT inject the key for the search host (DDG is keyless)', async () => {
    const app = buildApp({ openrouterKey: 'sk-secret' })
    await drain(await app.handle(freeProxyRequest('https://html.duckduckgo.com/html/?q=x')))
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Headers).get('authorization')).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  it('returns 429 once the rate limit is exceeded', async () => {
    const app = buildApp({ rateLimit: countingRateLimit(2) })
    const target = 'https://html.duckduckgo.com/html/?q=x'

    const first = await drain(await app.handle(freeProxyRequest(target)))
    const second = await drain(await app.handle(freeProxyRequest(target)))
    const third = await drain(await app.handle(freeProxyRequest(target)))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third.status).toBe(429)
    expect(third.headers.get('Retry-After')).toBeTruthy()
    // The limiter short-circuits before the handler proxies the third request.
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
