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
  haystackApiKey: '',
  haystackBaseUrl: 'https://api.cloud.deepset.ai',
  haystackWorkspace: '',
  haystackPipelineName: '',
  haystackPipelineId: '',
  haystackPipelines: '',
  enabledAgents: '',
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
  allowCustomAgents: true,
  betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
  rateLimitEnabled: false,
  swaggerEnabled: false,
  trustedProxy: '',
}

describe('OIDC Integration', () => {
  let oidcServer: OAuth2Server
  let oidcIssuerUrl: string

  beforeAll(async () => {
    oidcServer = new OAuth2Server()
    await oidcServer.issuer.keys.generate('RS256')
    await oidcServer.start(0, 'localhost')
    oidcIssuerUrl = oidcServer.issuer.url!
  })

  afterAll(async () => {
    await oidcServer.stop()
  })

  describe('OIDC sign-in endpoint', () => {
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
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: oidcIssuerUrl,
      } as Settings)
    })

    afterEach(() => {
      getSettingsSpy.mockRestore()
    })

    it('should return a redirect URL pointing to the OIDC provider', async () => {
      // Temporarily restore real fetch so Better Auth can reach the mock OIDC server
      const mockedFetch = globalThis.fetch
      globalThis.fetch = realFetch

      try {
        // Need a fresh import since settings are read at module level
        // Use createAuth directly with the test DB
        const { createAuth } = await import('./auth')
        const auth = createAuth(db)
        const app = new Elysia({ prefix: '/v1' }).mount(auth.handler)

        const res = await app.handle(
          new Request('http://localhost/v1/api/auth/sign-in/oauth2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              providerId: 'oidc',
              callbackURL: 'http://localhost:1420/',
            }),
          }),
        )

        expect(res.ok).toBe(true)

        const body = await res.json()
        expect(body.url).toContain(oidcIssuerUrl)
        expect(body.url).toContain('response_type=code')
        expect(body.url).toContain('client_id=thunderbolt-app')
      } finally {
        globalThis.fetch = mockedFetch
      }
    })
  })
})
