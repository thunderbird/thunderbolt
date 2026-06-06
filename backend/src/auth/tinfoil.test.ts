/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { createTestSettings } from '@/test-utils/settings'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createTinfoilAuthRoutes } from './tinfoil'

describe('Tinfoil OAuth Routes', () => {
  let app: { handle: Elysia['handle'] }
  let mockFetch: ReturnType<typeof mock>
  let lastRequest: { url: string; body: URLSearchParams } | null
  let getSettingsSpy: ReturnType<typeof spyOn>
  let consoleSpies: ConsoleSpies

  const tokenResponse = (status = 200, body: Record<string, unknown> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()

    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(
      createTestSettings({ tinfoilClientId: 'oauthc_test' }),
    )

    mockFetch = mock((url: string, init?: RequestInit) => {
      lastRequest = { url, body: new URLSearchParams(String(init?.body ?? '')) }
      return Promise.resolve(
        tokenResponse(200, {
          access_token: 'jwt.access.token',
          refresh_token: 'rotated.refresh.token',
          expires_in: 900,
          token_type: 'Bearer',
          scope: 'inference:api offline_access',
        }),
      )
    })

    app = new Elysia().use(createTinfoilAuthRoutes(mockAuth, mockFetch as unknown as typeof fetch))
  })

  afterEach(() => {
    lastRequest = null
    mockFetch.mockClear()
    getSettingsSpy.mockReturnValue(createTestSettings({ tinfoilClientId: 'oauthc_test' }))
  })

  afterAll(() => {
    getSettingsSpy.mockRestore()
    consoleSpies.restore()
  })

  describe('auth guard', () => {
    it('rejects unauthenticated requests', async () => {
      const unauthApp = new Elysia().use(
        createTinfoilAuthRoutes(mockAuthUnauthenticated, mockFetch as unknown as typeof fetch),
      )
      const response = await unauthApp.handle(new Request('http://localhost/auth/tinfoil/config'))
      expect(response.status).toBe(401)
    })
  })

  describe('/config', () => {
    it('returns configured: true when a client_id is set (no secret needed)', async () => {
      const response = await app.handle(new Request('http://localhost/auth/tinfoil/config'))
      const body = await response.json()
      expect(body).toEqual({ client_id: 'oauthc_test', configured: true })
    })

    it('returns configured: false when client_id is empty', async () => {
      getSettingsSpy.mockReturnValue(createTestSettings({ tinfoilClientId: '' }))
      const response = await app.handle(new Request('http://localhost/auth/tinfoil/config'))
      const body = await response.json()
      expect(body).toEqual({ client_id: '', configured: false })
    })
  })

  describe('/exchange', () => {
    const exchangeRequest = (redirectUri = 'http://localhost:1420/oauth/callback') =>
      new Request('http://localhost/auth/tinfoil/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'auth-code', code_verifier: 'verifier', redirect_uri: redirectUri }),
      })

    it('exchanges the code as a public client — client_id + PKCE, never a secret', async () => {
      const response = await app.handle(exchangeRequest())
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({
        access_token: 'jwt.access.token',
        refresh_token: 'rotated.refresh.token',
        expires_in: 900,
        token_type: 'Bearer',
        scope: 'inference:api offline_access',
      })

      expect(lastRequest?.url).toBe('https://api.tinfoil.sh/oauth/token')
      expect(lastRequest?.body.get('grant_type')).toBe('authorization_code')
      expect(lastRequest?.body.get('client_id')).toBe('oauthc_test')
      expect(lastRequest?.body.get('code_verifier')).toBe('verifier')
      expect(lastRequest?.body.has('client_secret')).toBe(false)
    })

    it('rejects an untrusted redirect_uri', async () => {
      const response = await app.handle(exchangeRequest('https://evil.example.com/callback'))
      expect(response.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('returns 503 when not configured', async () => {
      getSettingsSpy.mockReturnValue(createTestSettings({ tinfoilClientId: '' }))
      const response = await app.handle(exchangeRequest())
      expect(response.status).toBe(503)
    })
  })

  describe('/refresh', () => {
    it('refreshes and surfaces the rotated refresh token without a secret', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/tinfoil/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: 'old.refresh.token' }),
        }),
      )
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.refresh_token).toBe('rotated.refresh.token')
      expect(lastRequest?.body.get('grant_type')).toBe('refresh_token')
      expect(lastRequest?.body.get('client_id')).toBe('oauthc_test')
      expect(lastRequest?.body.has('client_secret')).toBe(false)
    })
  })

  describe('/revoke', () => {
    it('posts to the revoke endpoint and reports success', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/tinfoil/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: 'some.refresh.token' }),
        }),
      )
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({ revoked: true })
      expect(lastRequest?.url).toBe('https://api.tinfoil.sh/oauth/revoke')
      expect(lastRequest?.body.get('token')).toBe('some.refresh.token')
    })
  })
})
