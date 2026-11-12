/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import * as settingsModule from '@/config/settings'
import { createTestSettings } from '@/test-utils/settings'
import { mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { createIntegrationOAuthRoutes } from './integration-oauth'

const verifier = 'v'.repeat(43)
const settings = createTestSettings({
  integrationOAuthAllowPublic: true,
  googleClientId: 'google-id',
  googleClientSecret: 'google-secret',
  microsoftClientId: 'microsoft-id',
  microsoftClientSecret: 'microsoft-secret',
})

beforeEach(() => {
  spyOn(settingsModule, 'getSettings').mockReturnValue(settings)
})
afterEach(() => mock.restore())

for (const provider of ['google', 'microsoft'] as const) {
  describe(`${provider} public integration relay`, () => {
    const setup = (
      response: () => Response = () =>
        Response.json({
          access_token: 'access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          client_secret: 'must-not-leak',
        }),
    ) => {
      const fetch = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => response())
      const app = createIntegrationOAuthRoutes(
        provider,
        mockAuthUnauthenticated,
        Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }),
        new Elysia(),
      )
      const post = (path: string, body: unknown, extraHeaders: Record<string, string> = {}) =>
        app.handle(
          new Request(`http://localhost/auth/${provider}/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...extraHeaders },
            body: JSON.stringify(body),
          }),
        )
      return { app, fetch, post }
    }

    it('exchanges only the bounded grant fields without a Thunderbolt session and never caches tokens', async () => {
      const { post, fetch } = setup()
      const response = await post('exchange', {
        code: 'authorized-code',
        code_verifier: verifier,
        redirect_uri: 'http://localhost:1420/oauth/callback',
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.json()).toEqual({
        access_token: 'access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      })
      const init = fetch.mock.calls[0][1]!
      const body = init.body as URLSearchParams
      expect(body.get('code_verifier')).toBe(verifier)
      expect(body.get('client_secret')).toBe(`${provider}-secret`)
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('keeps all relay endpoints session-protected unless the operator opts in', async () => {
      spyOn(settingsModule, 'getSettings').mockReturnValue({ ...settings, integrationOAuthAllowPublic: false })
      const { app, post, fetch } = setup()
      expect((await app.handle(new Request(`http://localhost/auth/${provider}/config`))).status).toBe(401)
      expect(
        (
          await post('exchange', {
            code: 'code',
            code_verifier: verifier,
            redirect_uri: 'http://localhost:1420/oauth/callback',
          })
        ).status,
      ).toBe(401)
      expect((await post('refresh', { refresh_token: 'refresh' })).status).toBe(401)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('retains the original refresh token when the provider does not rotate it', async () => {
      const { post } = setup(() => Response.json({ access_token: 'new', expires_in: 3600, token_type: 'Bearer' }))
      const response = await post('refresh', { refresh_token: 'original' })
      expect(response.status).toBe(200)
      expect((await response.json()).refresh_token).toBe('original')
    })

    it.each(['', 'too-short', 'v'.repeat(129), '!'.repeat(43)])(
      'rejects an invalid PKCE verifier before contacting the provider: %s',
      async (code_verifier) => {
        const { post, fetch } = setup()
        const response = await post('exchange', {
          code: 'sensitive-code',
          code_verifier,
          redirect_uri: 'http://localhost:1420/oauth/callback',
        })
        expect(response.status).toBe(422)
        expect(await response.text()).not.toContain('sensitive-code')
        expect(fetch).not.toHaveBeenCalled()
      },
    )

    it('rejects an untrusted redirect and browser origin before forwarding credentials', async () => {
      const { post, fetch } = setup()
      expect(
        (
          await post('exchange', {
            code: 'code',
            code_verifier: verifier,
            redirect_uri: 'https://attacker.example/callback',
          })
        ).status,
      ).toBe(400)
      expect((await post('refresh', { refresh_token: 'refresh' }, { Origin: 'https://attacker.example' })).status).toBe(
        403,
      )
      expect(fetch).not.toHaveBeenCalled()
    })

    it('rejects oversized refresh tokens and non-JSON submissions', async () => {
      const { post, fetch } = setup()
      expect((await post('refresh', { refresh_token: 'r'.repeat(16385) })).status).toBe(422)
      expect((await post('refresh', { refresh_token: 'refresh' }, { 'Content-Type': 'text/plain' })).status).toBe(422)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('does not expose provider errors or invalid credential responses', async () => {
      const { post } = setup(() => Response.json({ error_description: 'sensitive-token' }, { status: 400 }))
      const response = await post('refresh', { refresh_token: 'refresh' })
      expect(response.status).toBe(400)
      expect(await response.text()).not.toContain('sensitive-token')
    })

    it.each([429, 500, 503])(
      'reports an upstream %s as temporary without asking users to reconnect',
      async (status) => {
        const { post } = setup(() => Response.json({ error_description: 'sensitive-token' }, { status }))
        const response = await post('refresh', { refresh_token: 'refresh' })
        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: 'OAuth provider is unavailable. Try again.' })
      },
    )

    it('does not log or echo malformed request bodies', async () => {
      const { app, fetch } = setup()
      const log = spyOn(console, 'error').mockImplementation(() => {})
      const response = await app.handle(
        new Request(`http://localhost/auth/${provider}/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"refresh_token":"sensitive-refresh-token"',
        }),
      )
      expect(response.status).toBe(422)
      expect(await response.text()).toBe('{"error":"Invalid OAuth request"}')
      expect(log).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('rejects malformed provider responses without returning their contents', async () => {
      const { post } = setup(() => Response.json({ access_token: 'secret-invalid' }))
      const response = await post('refresh', { refresh_token: 'refresh' })
      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain('secret-invalid')
    })

    it('applies the supplied rate limiter before config, exchange, and refresh', async () => {
      const fetch = mock(async () => Response.json({}))
      const limiter = new Elysia()
        .onBeforeHandle(({ set }) => {
          set.status = 429
          return { error: 'Rate limited' }
        })
        .as('scoped')
      const app = createIntegrationOAuthRoutes(
        provider,
        mockAuthUnauthenticated,
        Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }),
        limiter,
      )
      for (const path of ['config', 'exchange', 'refresh']) {
        const body =
          path === 'exchange'
            ? { code: 'code', code_verifier: verifier, redirect_uri: 'http://localhost:1420/oauth/callback' }
            : { refresh_token: 'refresh' }
        const response = await app.handle(
          new Request(
            `http://localhost/auth/${provider}/${path}`,
            path === 'config'
              ? {}
              : {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                },
          ),
        )
        expect(response.status).toBe(429)
      }
      expect(fetch).not.toHaveBeenCalled()
    })
  })
}

it('enforces the shared limiter on both providers without applying it to unrelated routes', async () => {
  const limiter = new Elysia()
    .onBeforeHandle(({ set }) => {
      set.status = 429
      return { error: 'Rate limited' }
    })
    .as('scoped')
  const fetch = mock(async () => Response.json({}))
  const fetchFn = Object.assign(fetch, { preconnect: globalThis.fetch.preconnect })
  const app = new Elysia()
    .use(createIntegrationOAuthRoutes('google', mockAuthUnauthenticated, fetchFn, limiter))
    .use(createIntegrationOAuthRoutes('microsoft', mockAuthUnauthenticated, fetchFn, limiter))
    .get('/unrelated', () => 'ok')
    .post('/unrelated', () => 'ok', { parse: 'none' })
    .post('/manual-json', ({ request }) => request.json())
  for (const provider of ['google', 'microsoft']) {
    expect((await app.handle(new Request(`http://localhost/auth/${provider}/config`))).status).toBe(429)
  }
  expect((await app.handle(new Request('http://localhost/unrelated'))).status).toBe(200)
  const unrelated = await app.handle(
    new Request('http://localhost/unrelated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://unrelated.example' },
      body: 'opaque payload',
    }),
  )
  expect(unrelated.status).toBe(200)
  expect(await unrelated.text()).toBe('ok')
  expect(unrelated.headers.get('Cache-Control')).toBeNull()
  const manualJson = await app.handle(
    new Request('http://localhost/manual-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"message":"unchanged"}',
    }),
  )
  expect(manualJson.status).toBe(200)
  expect(await manualJson.json()).toEqual({ message: 'unchanged' })
  expect(fetch).not.toHaveBeenCalled()
})
