/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { createTestSettings } from '@/test-utils/settings'
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createGoogleAuthRoutes } from './google'
import { createMicrosoftAuthRoutes } from './microsoft'
import { createTinfoilAuthRoutes } from './tinfoil'

describe('Authentication Routes', () => {
  let app: { handle: Elysia['handle'] }
  let mockFetch: ReturnType<typeof mock>
  let getSettingsSpy: ReturnType<typeof spyOn>
  let consoleSpies: ConsoleSpies

  const createMockOAuthResponse = (status = 200, body: any = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  beforeAll(async () => {
    consoleSpies = setupConsoleSpy()

    // Mock settings
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(
      createTestSettings({
        googleClientId: 'test-google-client-id',
        googleClientSecret: 'test-google-secret',
        microsoftClientId: 'test-microsoft-client-id',
        microsoftClientSecret: 'test-microsoft-secret',
        tinfoilClientId: 'test-tinfoil-client-id',
      }),
    )

    // Create mock fetch
    mockFetch = mock(() => Promise.resolve(createMockOAuthResponse()))

    // Inject mock fetch into routes
    app = new Elysia()
      .use(createGoogleAuthRoutes(mockAuth, mockFetch as unknown as typeof fetch))
      .use(createMicrosoftAuthRoutes(mockAuth, mockFetch as unknown as typeof fetch))
      .use(createTinfoilAuthRoutes(mockAuth, mockFetch as unknown as typeof fetch))
  })

  afterAll(async () => {
    getSettingsSpy?.mockRestore()
    consoleSpies.restore()
  })

  describe('auth guard', () => {
    let unauthApp: { handle: Elysia['handle'] }

    beforeAll(() => {
      unauthApp = new Elysia()
        .use(createGoogleAuthRoutes(mockAuthUnauthenticated, mockFetch as unknown as typeof fetch))
        .use(createMicrosoftAuthRoutes(mockAuthUnauthenticated, mockFetch as unknown as typeof fetch))
        .use(createTinfoilAuthRoutes(mockAuthUnauthenticated, mockFetch as unknown as typeof fetch))
    })

    it('should reject unauthenticated requests to Google config', async () => {
      const response = await unauthApp.handle(new Request('http://localhost/auth/google/config'))
      expect(response.status).toBe(401)
    })

    it('should reject unauthenticated requests to Google exchange', async () => {
      const response = await unauthApp.handle(
        new Request('http://localhost/auth/google/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'test', code_verifier: 'test', redirect_uri: 'http://localhost' }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('should reject unauthenticated requests to Microsoft config', async () => {
      const response = await unauthApp.handle(new Request('http://localhost/auth/microsoft/config'))
      expect(response.status).toBe(401)
    })

    it('should reject unauthenticated requests to Microsoft exchange', async () => {
      const response = await unauthApp.handle(
        new Request('http://localhost/auth/microsoft/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'test', code_verifier: 'test', redirect_uri: 'http://localhost' }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('should reject unauthenticated requests to Tinfoil config', async () => {
      const response = await unauthApp.handle(new Request('http://localhost/auth/tinfoil/config'))
      expect(response.status).toBe(401)
    })
  })

  describe('Google OAuth', () => {
    it('returns configured: true for Google /config when credentials are set', async () => {
      const response = await app.handle(new Request('http://localhost/auth/google/config'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ client_id: 'test-google-client-id', configured: true })
    })

    it('returns configured: false for Google /config when secret is empty', async () => {
      getSettingsSpy.mockReturnValueOnce(
        createTestSettings({
          googleClientId: 'test-google-client-id',
          microsoftClientId: 'test-microsoft-client-id',
          microsoftClientSecret: 'test-microsoft-secret',
        }),
      )
      const response = await app.handle(new Request('http://localhost/auth/google/config'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ client_id: 'test-google-client-id', configured: false })
    })

    it('returns configured: false for Google /config when both empty', async () => {
      getSettingsSpy.mockReturnValueOnce(
        createTestSettings({
          microsoftClientId: 'test-microsoft-client-id',
          microsoftClientSecret: 'test-microsoft-secret',
        }),
      )
      const response = await app.handle(new Request('http://localhost/auth/google/config'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ client_id: '', configured: false })
    })

    it('should require valid body for token exchange', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/google/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(422)
    })

    it('should require valid body for token refresh', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/google/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(422)
    })
  })

  describe('Microsoft OAuth', () => {
    it('returns configured: true for Microsoft /config when credentials are set', async () => {
      const response = await app.handle(new Request('http://localhost/auth/microsoft/config'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ client_id: 'test-microsoft-client-id', configured: true })
    })

    it('returns configured: false for Microsoft /config when secret is empty', async () => {
      getSettingsSpy.mockReturnValueOnce(
        createTestSettings({
          googleClientId: 'test-google-client-id',
          googleClientSecret: 'test-google-secret',
          microsoftClientId: 'test-microsoft-client-id',
        }),
      )
      const response = await app.handle(new Request('http://localhost/auth/microsoft/config'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ client_id: 'test-microsoft-client-id', configured: false })
    })

    it('returns configured: false for Microsoft /config when both empty', async () => {
      getSettingsSpy.mockReturnValueOnce(
        createTestSettings({
          googleClientId: 'test-google-client-id',
          googleClientSecret: 'test-google-secret',
        }),
      )
      const response = await app.handle(new Request('http://localhost/auth/microsoft/config'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ client_id: '', configured: false })
    })

    it('should require valid body for token exchange', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/microsoft/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(422)
    })

    it('should require valid body for token refresh', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/microsoft/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(422)
    })
  })

  // Tinfoil is a public OAuth 2.1 client (PKCE, no secret), so these assert the
  // token requests carry a client_id + code_verifier and NEVER a client_secret.
  describe('Tinfoil OAuth', () => {
    const tinfoilTokenResponse = {
      access_token: 'jwt.access.token',
      refresh_token: 'rotated.refresh.token',
      expires_in: 900,
      token_type: 'Bearer',
      scope: 'inference:api offline_access',
    }

    // The last outbound request the mock fetch received, as URL + parsed body.
    const lastSent = () => {
      const call = mockFetch.mock.calls.at(-1) as unknown as [string, RequestInit] | undefined
      return { url: call?.[0], body: new URLSearchParams(String(call?.[1]?.body ?? '')) }
    }

    it('returns configured: true for /config when a client_id is set (no secret needed)', async () => {
      const response = await app.handle(new Request('http://localhost/auth/tinfoil/config'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ client_id: 'test-tinfoil-client-id', configured: true })
    })

    it('exchanges the code as a public client — client_id + PKCE, never a secret', async () => {
      mockFetch.mockClear()
      mockFetch.mockResolvedValueOnce(createMockOAuthResponse(200, tinfoilTokenResponse))
      const response = await app.handle(
        new Request('http://localhost/auth/tinfoil/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 'auth-code',
            code_verifier: 'verifier',
            redirect_uri: 'http://localhost:1420/oauth/callback',
          }),
        }),
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(tinfoilTokenResponse)

      const sent = lastSent()
      expect(sent.url).toBe('https://api.tinfoil.sh/oauth/token')
      expect(sent.body.get('grant_type')).toBe('authorization_code')
      expect(sent.body.get('client_id')).toBe('test-tinfoil-client-id')
      expect(sent.body.get('code_verifier')).toBe('verifier')
      expect(sent.body.has('client_secret')).toBe(false)
    })

    it('returns 503 for exchange when not configured', async () => {
      getSettingsSpy.mockReturnValueOnce(createTestSettings({}))
      const response = await app.handle(
        new Request('http://localhost/auth/tinfoil/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 'auth-code',
            code_verifier: 'verifier',
            redirect_uri: 'http://localhost:1420/oauth/callback',
          }),
        }),
      )
      expect(response.status).toBe(503)
    })

    it('refreshes and surfaces the rotated refresh token without a secret', async () => {
      mockFetch.mockClear()
      mockFetch.mockResolvedValueOnce(createMockOAuthResponse(200, tinfoilTokenResponse))
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

      const sent = lastSent()
      expect(sent.body.get('grant_type')).toBe('refresh_token')
      expect(sent.body.get('client_id')).toBe('test-tinfoil-client-id')
      expect(sent.body.has('client_secret')).toBe(false)
    })

    it('revokes the token and reports success', async () => {
      mockFetch.mockClear()
      mockFetch.mockResolvedValueOnce(createMockOAuthResponse(200, {}))
      const response = await app.handle(
        new Request('http://localhost/auth/tinfoil/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: 'some.refresh.token' }),
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ revoked: true })

      const sent = lastSent()
      expect(sent.url).toBe('https://api.tinfoil.sh/oauth/revoke')
      expect(sent.body.get('token')).toBe('some.refresh.token')
    })
  })

  describe('redirect_uri validation', () => {
    it('rejects Google exchange with disallowed redirect_uri', async () => {
      mockFetch.mockClear()
      const response = await app.handle(
        new Request('http://localhost/auth/google/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 'test-code',
            code_verifier: 'test-verifier',
            redirect_uri: 'https://evil.com/steal',
          }),
        }),
      )
      expect(response.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('rejects Microsoft exchange with disallowed redirect_uri', async () => {
      mockFetch.mockClear()
      const response = await app.handle(
        new Request('http://localhost/auth/microsoft/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 'test-code',
            code_verifier: 'test-verifier',
            redirect_uri: 'https://evil.com/steal',
          }),
        }),
      )
      expect(response.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('rejects Tinfoil exchange with disallowed redirect_uri', async () => {
      mockFetch.mockClear()
      const response = await app.handle(
        new Request('http://localhost/auth/tinfoil/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 'test-code',
            code_verifier: 'test-verifier',
            redirect_uri: 'https://evil.com/steal',
          }),
        }),
      )
      expect(response.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('allows Google exchange with valid localhost redirect_uri', async () => {
      mockFetch.mockClear()
      mockFetch.mockResolvedValueOnce(
        createMockOAuthResponse(200, {
          access_token: 'token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      const response = await app.handle(
        new Request('http://localhost/auth/google/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 'test-code',
            code_verifier: 'test-verifier',
            redirect_uri: 'http://localhost:1420/oauth/callback',
          }),
        }),
      )
      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('allows Microsoft exchange with valid localhost redirect_uri', async () => {
      mockFetch.mockClear()
      mockFetch.mockResolvedValueOnce(
        createMockOAuthResponse(200, {
          access_token: 'token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      const response = await app.handle(
        new Request('http://localhost/auth/microsoft/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 'test-code',
            code_verifier: 'test-verifier',
            redirect_uri: 'http://localhost:1420/oauth/callback',
          }),
        }),
      )
      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })
})
