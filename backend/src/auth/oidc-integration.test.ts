/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mock } from 'bun:test'
import * as authUtils from '@/auth/utils'
import * as waitlistUtils from '@/waitlist/utils'
import * as settingsModule from '@/config/settings'
import type { Settings } from '@/config/settings'

// createAuth transitively imports email-sending functions at the module level.
// Until createAuth accepts these as injectable dependencies, we mock them here
// to prevent real emails from being sent during tests.
mock.module('@/auth/utils', () => ({
  ...authUtils,
  sendSignInEmail: mock(() => Promise.resolve()),
}))

mock.module('@/waitlist/utils', () => ({
  ...waitlistUtils,
  sendWaitlistNotReadyEmail: mock(() => Promise.resolve()),
  sendWaitlistJoinedEmail: mock(() => Promise.resolve()),
  sendWaitlistReminderEmail: mock(() => Promise.resolve()),
}))

import { OAuth2Server } from 'oauth2-mock-server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createTestDb } from '@/test-utils/db'

const realFetch = (globalThis as Record<string, unknown>).__originalFetch as typeof fetch

/** Base settings for OIDC tests — issuer URL is overridden per-suite */
const baseSettings: Settings = {
  fireworksApiKey: '',
  mistralApiKey: '',
  anthropicApiKey: '',
  exaApiKey: '',
  thunderboltInferenceUrl: '',
  thunderboltInferenceApiKey: '',
  monitoringToken: '',
  googleClientId: '',
  googleClientSecret: '',
  microsoftClientId: '',
  microsoftClientSecret: '',
  logLevel: 'ERROR',
  port: 8000,
  appUrl: 'http://localhost:1420',
  posthogHost: '',
  posthogApiKey: '',
  corsOrigins: 'http://localhost:1420',
  corsAllowCredentials: true,
  corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
  corsAllowHeaders: 'Content-Type,Authorization',
  corsExposeHeaders: '',
  waitlistEnabled: false,
  waitlistAutoApproveDomains: '',
  powersyncUrl: '',
  powersyncJwtKid: '',
  powersyncJwtSecret: '',
  powersyncTokenExpirySeconds: 3600,
  authMode: 'oidc' as const,
  oidcClientId: 'thunderbolt-app',
  oidcClientSecret: 'thunderbolt-dev-secret',
  oidcIssuer: '', // set per-suite once mock server is up
  betterAuthUrl: 'http://localhost:8000',
  betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
  rateLimitEnabled: false,
  swaggerEnabled: false,
  e2eeEnabled: false,
  trustedProxy: '',
  samlEntryPoint: '',
  samlEntityId: '',
  samlIdpIssuer: '',
  samlCert: '',
}

/** Save and restore globalThis.fetch + process.env.TRUSTED_ORIGINS around a test body. */
const withRealFetch = async (oidcIssuerUrl: string, fn: () => Promise<void>) => {
  const savedFetch = globalThis.fetch
  const savedOrigins = process.env.TRUSTED_ORIGINS
  globalThis.fetch = realFetch
  process.env.TRUSTED_ORIGINS = `http://localhost:1420,${oidcIssuerUrl}`

  try {
    await fn()
  } finally {
    globalThis.fetch = savedFetch
    process.env.TRUSTED_ORIGINS = savedOrigins
  }
}

describe('OIDC Integration', () => {
  let oidcServer: OAuth2Server
  let oidcIssuerUrl: string
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let getSettingsSpy: ReturnType<typeof spyOn>

  beforeAll(async () => {
    oidcServer = new OAuth2Server()
    await oidcServer.issuer.keys.generate('RS256')
    await oidcServer.start(0, 'localhost')
    oidcIssuerUrl = oidcServer.issuer.url!

    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterAll(async () => {
    await oidcServer.stop()
    await cleanup()
  })

  afterEach(() => {
    getSettingsSpy?.mockRestore()
  })

  describe('OIDC sign-in endpoint', () => {
    beforeEach(() => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: oidcIssuerUrl,
      } as Settings)
    })

    it('should return a redirect URL pointing to the OIDC provider', async () => {
      await withRealFetch(oidcIssuerUrl, async () => {
        const { createAuth } = await import('./auth')
        const auth = createAuth(db)
        const app = new Elysia({ prefix: '/v1' }).mount(auth.handler)

        const res = await app.handle(
          new Request('http://localhost/v1/api/auth/sign-in/sso', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              providerId: 'sso',
              callbackURL: 'http://localhost:1420/',
            }),
          }),
        )

        expect(res.ok).toBe(true)

        const body = await res.json()
        expect(body.url).toContain(oidcIssuerUrl)
        expect(body.url).toContain('response_type=code')
        expect(body.url).toContain('client_id=thunderbolt-app')
      })
    })

    it('should include PKCE code_challenge in the redirect URL', async () => {
      await withRealFetch(oidcIssuerUrl, async () => {
        const { createAuth } = await import('./auth')
        const auth = createAuth(db)
        const app = new Elysia({ prefix: '/v1' }).mount(auth.handler)

        const res = await app.handle(
          new Request('http://localhost/v1/api/auth/sign-in/sso', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              providerId: 'sso',
              callbackURL: 'http://localhost:1420/',
            }),
          }),
        )

        expect(res.ok).toBe(true)

        const body = await res.json()
        expect(body.url).toContain('code_challenge=')
        expect(body.url).toContain('code_challenge_method=S256')
      })
    })

    it('should include openid, profile, and email scopes', async () => {
      await withRealFetch(oidcIssuerUrl, async () => {
        const { createAuth } = await import('./auth')
        const auth = createAuth(db)
        const app = new Elysia({ prefix: '/v1' }).mount(auth.handler)

        const res = await app.handle(
          new Request('http://localhost/v1/api/auth/sign-in/sso', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              providerId: 'sso',
              callbackURL: 'http://localhost:1420/',
            }),
          }),
        )

        expect(res.ok).toBe(true)

        const body = await res.json()
        const url = new URL(body.url)
        const scope = url.searchParams.get('scope') ?? ''
        expect(scope).toContain('openid')
        expect(scope).toContain('profile')
        expect(scope).toContain('email')
      })
    })
  })

  describe('OIDC configuration validation', () => {
    it('should throw when OIDC_ISSUER is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: '',
        oidcClientId: 'some-client',
        oidcClientSecret: 'some-secret',
      } as Settings)

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('OIDC_ISSUER')
    })

    it('should throw when OIDC_CLIENT_ID is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: 'https://idp.example.com',
        oidcClientId: '',
        oidcClientSecret: 'some-secret',
      } as Settings)

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('OIDC_CLIENT_ID')
    })

    it('should throw when OIDC_CLIENT_SECRET is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: 'https://idp.example.com',
        oidcClientId: 'some-client',
        oidcClientSecret: '',
      } as Settings)

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('OIDC_CLIENT_SECRET')
    })
  })

  describe('SSO endpoint unavailable in consumer mode', () => {
    it('should reject SSO sign-in when AUTH_MODE=consumer', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        authMode: 'consumer' as const,
        oidcIssuer: '',
        oidcClientId: '',
        oidcClientSecret: '',
      } as Settings)

      const { createAuth } = await import('./auth')
      const auth = createAuth(db)
      const app = new Elysia({ prefix: '/v1' }).mount(auth.handler)

      const res = await app.handle(
        new Request('http://localhost/v1/api/auth/sign-in/sso', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId: 'sso',
            callbackURL: 'http://localhost:1420/',
          }),
        }),
      )

      expect(res.ok).toBe(false)
    })
  })
})
