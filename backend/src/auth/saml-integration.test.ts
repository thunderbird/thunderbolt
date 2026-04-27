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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createTestDb } from '@/test-utils/db'

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
  samlIssuer: 'http://fake-idp.example.com',
  samlCert:
    'MIICpDCCAYwCCQDU+pQ4pHgSpDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwHhcNMjQwMTAxMDAwMDAwWhcNMjUwMTAxMDAwMDAwWjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7o4QFMSok',
}

describe('SAML Integration', () => {
  describe('SAML sign-in endpoint', () => {
    let db: Awaited<ReturnType<typeof createTestDb>>['db']
    let cleanup: () => Promise<void>
    let getSettingsSpy: ReturnType<typeof spyOn>

    beforeAll(async () => {
      const testEnv = await createTestDb()
      db = testEnv.db
      cleanup = testEnv.cleanup
    })

    afterAll(async () => {
      await cleanup()
    })

    beforeEach(() => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(baseSettings)
    })

    afterEach(() => {
      getSettingsSpy.mockRestore()
    })

    it('should return a redirect URL pointing to the SAML IdP', async () => {
      const { createAuth } = await import('./auth')
      const auth = createAuth(db)
      const app = new Elysia({ prefix: '/v1' }).mount(auth.handler)

      const res = await app.handle(
        new Request('http://localhost/v1/api/auth/sign-in/sso', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId: 'saml',
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
})
