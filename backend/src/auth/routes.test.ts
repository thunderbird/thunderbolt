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
      }),
    )

    // Create mock fetch
    mockFetch = mock(() => Promise.resolve(createMockOAuthResponse()))

    // Inject mock fetch into routes
    app = new Elysia()
      .use(createGoogleAuthRoutes(mockAuth, mockFetch as unknown as typeof fetch))
      .use(createMicrosoftAuthRoutes(mockAuth, mockFetch as unknown as typeof fetch))
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
