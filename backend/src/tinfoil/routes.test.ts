/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { createTinfoilRoutes } from './routes'

const enclaveUrl = 'https://inference.tinfoil.sh'
const testApiKey = 'test-tinfoil-key'

const makeOkResponse = (body = 'ok', extraHeaders: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain', ...extraHeaders },
  })

/** Read the response body so capStream-style idle timers (if any) clear. */
const drain = async (res: Response): Promise<Response> => {
  if (res.body) {
    await res.arrayBuffer()
  }
  return res
}

describe('createTinfoilRoutes', () => {
  let mockFetch: ReturnType<typeof mock>
  let consoleSpies: ConsoleSpies

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
    consoleSpies.error.mockClear()
  })

  const buildApp = (overrides: { apiKey?: string; enclaveUrl?: string; auth?: typeof mockAuth } = {}) =>
    new Elysia().use(
      createTinfoilRoutes({
        auth: overrides.auth ?? mockAuth,
        fetchFn: mockFetch as unknown as typeof fetch,
        apiKey: overrides.apiKey ?? testApiKey,
        enclaveUrl: overrides.enclaveUrl ?? enclaveUrl,
      }),
    )

  describe('configuration', () => {
    it('returns 503 when the Tinfoil API key is not configured', async () => {
      const app = buildApp({ apiKey: '' })
      const res = await app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(res.status).toBe(503)
      expect(await res.text()).toBe('Tinfoil provider not configured')
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('method allowlist', () => {
    it.each(['PUT', 'DELETE', 'PATCH'])('returns 405 for disallowed method %s', async (method) => {
      const app = buildApp()
      const res = await app.handle(new Request('http://localhost/tinfoil/anything', { method, body: '' }))

      expect(res.status).toBe(405)
      expect(await res.text()).toBe('Method not allowed')
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('header handling', () => {
    it('strips inbound Authorization and injects the server bearer key', async () => {
      const app = buildApp()
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer client-supplied-secret',
              'content-type': 'application/octet-stream',
            },
            body: 'opaque-bytes',
          }),
        ),
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const sent = init.headers as Headers
      expect(sent.get('authorization')).toBe(`Bearer ${testApiKey}`)
      expect(sent.get('authorization')).not.toBe('Bearer client-supplied-secret')
    })

    it('strips hop-by-hop headers (cookie, host, connection)', async () => {
      const app = buildApp()
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: {
              cookie: 'session=abc',
              connection: 'keep-alive',
            },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const sent = init.headers as Headers
      expect(sent.get('cookie')).toBeNull()
      expect(sent.get('connection')).toBeNull()
    })
  })

  describe('body forwarding', () => {
    it('forwards the request body for POST requests', async () => {
      const app = buildApp()
      const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04])

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: payload,
          }),
        ),
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${enclaveUrl}/v1/chat/completions`)
      expect(init.body).not.toBeNull()
      expect(init.method).toBe('POST')
    })

    it('forwards JSON bodies untouched (parse: none keeps the stream intact)', async () => {
      const app = buildApp()
      const jsonBody = JSON.stringify({ model: 'deepseek-v4-pro', messages: [] })

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: jsonBody,
          }),
        ),
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.body).not.toBeNull()
    })

    it('does not forward a body for GET requests', async () => {
      const app = buildApp()
      await drain(await app.handle(new Request('http://localhost/tinfoil/v1/models', { method: 'GET' })))

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.body).toBeNull()
    })
  })

  describe('upstream URL derivation', () => {
    it('derives the upstream path from the wildcard, not the outer mount prefix', async () => {
      // Mount at a non-default outer prefix to prove the path comes from the wildcard.
      const app = new Elysia({ prefix: '/v2/alt' }).use(
        createTinfoilRoutes({
          auth: mockAuth,
          fetchFn: mockFetch as unknown as typeof fetch,
          apiKey: testApiKey,
          enclaveUrl,
        }),
      )

      await drain(
        await app.handle(
          new Request('http://localhost/v2/alt/tinfoil/v1/chat/completions?stream=true', {
            method: 'POST',
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${enclaveUrl}/v1/chat/completions?stream=true`)
    })

    it('strips trailing slash on the enclave URL before composing the upstream URL', async () => {
      const app = buildApp({ enclaveUrl: `${enclaveUrl}/` })
      await drain(await app.handle(new Request('http://localhost/tinfoil/v1/models', { method: 'GET' })))

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${enclaveUrl}/v1/models`)
    })

    it('composes the upstream URL correctly when the enclave URL carries the /v1 API prefix', async () => {
      // Production wiring: TINFOIL_ENCLAVE_URL=https://inference.tinfoil.sh/v1,
      // and the SDK builds the request URL without an inner /v1 (its baseURL is
      // already <cloudUrl>/tinfoil, where cloudUrl ends in /v1).
      const app = buildApp({ enclaveUrl: 'https://inference.tinfoil.sh/v1' })
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/chat/completions', {
            method: 'POST',
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe('https://inference.tinfoil.sh/v1/chat/completions')
    })
  })

  describe('authentication', () => {
    it('returns 401 when the session is null', async () => {
      const app = buildApp({ auth: mockAuthUnauthenticated })
      const res = await drain(await app.handle(new Request('http://localhost/tinfoil/v1/models', { method: 'GET' })))

      expect(res.status).toBe(401)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })
})
