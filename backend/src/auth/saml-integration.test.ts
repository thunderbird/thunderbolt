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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createTestDb } from '@/test-utils/db'

const realFetch = (globalThis as Record<string, unknown>).__originalFetch as typeof fetch

/** Save and restore globalThis.fetch around a test body. */
const withRealFetch = async (fn: () => Promise<void>) => {
  const savedFetch = globalThis.fetch
  globalThis.fetch = realFetch

  try {
    await fn()
  } finally {
    globalThis.fetch = savedFetch
  }
}

/** Base settings for SAML tests */
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
  authMode: 'saml' as const,
  oidcClientId: '',
  oidcClientSecret: '',
  oidcIssuer: '',
  betterAuthUrl: 'http://localhost:8000',
  betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
  rateLimitEnabled: false,
  swaggerEnabled: false,
  e2eeEnabled: false,
  trustedProxy: '',
  samlEntryPoint: 'http://fake-idp.example.com/saml/sso',
  samlEntityId: 'fake-saml-sp',
  samlIdpIssuer: 'http://fake-idp.example.com',
  samlCert:
    'MIICpDCCAYwCCQDU+pQ4pHgSpDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwHhcNMjQwMTAxMDAwMDAwWhcNMjUwMTAxMDAwMDAwWjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7o4QFMSok',
}

describe('SAML Integration', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let getSettingsSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    getSettingsSpy?.mockRestore()
    await cleanup()
  })

  describe('SAML sign-in endpoint', () => {
    beforeEach(() => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(baseSettings)
    })

    it('should return a redirect URL pointing to the SAML IdP', async () => {
      await withRealFetch(async () => {
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
        expect(body.url).toContain('fake-idp.example.com')
        expect(body.url).toContain('SAMLRequest')
      })
    })

    it('should include SP entity ID and ACS URL in the SAMLRequest', async () => {
      await withRealFetch(async () => {
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
        const samlRequestEncoded = url.searchParams.get('SAMLRequest')
        expect(samlRequestEncoded).toBeTruthy()

        // SAMLRequest is deflate-compressed + base64-encoded; decode to inspect XML
        const { inflateRawSync } = await import('node:zlib')
        const xml = inflateRawSync(Buffer.from(samlRequestEncoded!, 'base64')).toString()

        expect(xml).toContain('fake-saml-sp') // SP entity ID
        expect(xml).toContain('/v1/api/auth/sso/saml2/sp/acs/sso') // ACS URL
      })
    })

    it('should reject sign-in with unknown providerId', async () => {
      await withRealFetch(async () => {
        const { createAuth } = await import('./auth')
        const auth = createAuth(db)
        const app = new Elysia({ prefix: '/v1' }).mount(auth.handler)

        const res = await app.handle(
          new Request('http://localhost/v1/api/auth/sign-in/sso', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              providerId: 'unknown-provider',
              callbackURL: 'http://localhost:1420/',
            }),
          }),
        )

        expect(res.ok).toBe(false)
      })
    })
  })

  describe('SAML configuration validation', () => {
    it('should throw when SAML_ENTRY_POINT is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        samlEntryPoint: '',
      } as Settings)

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('SAML_ENTRY_POINT')
    })

    it('should throw when SAML_CERT is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        samlCert: '',
      } as Settings)

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('SAML_CERT')
    })

    it('should throw when SAML_ENTITY_ID is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        samlEntityId: '',
      } as Settings)

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('SAML_ENTITY_ID')
    })

    it('should throw when SAML_IDP_ISSUER is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        samlIdpIssuer: '',
      } as Settings)

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('SAML_IDP_ISSUER')
    })
  })

  describe('SSO endpoint unavailable in consumer mode', () => {
    it('should reject SSO sign-in when AUTH_MODE=consumer', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        authMode: 'consumer' as const,
        samlEntryPoint: '',
        samlEntityId: '',
        samlIdpIssuer: '',
        samlCert: '',
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
