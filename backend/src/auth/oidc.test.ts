import * as settingsModule from '@/config/settings'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createOidcConfigRoutes } from './oidc'

describe('OIDC config route', () => {
  let getSettingsSpy: ReturnType<typeof spyOn>

  afterAll(() => {
    getSettingsSpy?.mockRestore()
  })

  it('returns issuerOrigin when authMode is oidc', () => {
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
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
      logLevel: 'INFO',
      port: 8000,
      appUrl: 'http://localhost:1420',
      posthogHost: 'https://us.i.posthog.com',
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
      oidcClientId: 'test-client-id',
      oidcClientSecret: 'test-client-secret',
      oidcIssuer: 'https://auth.okta.com/some/path',
      betterAuthUrl: 'http://localhost:8000',
      betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
      rateLimitEnabled: false,
      swaggerEnabled: false,
      trustedProxy: '',
    })

    const app = new Elysia().use(createOidcConfigRoutes())

    return app.handle(new Request('http://localhost/auth/oidc/config')).then(async (response) => {
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ issuerOrigin: 'https://auth.okta.com' })
    })
  })

  it('returns 404 when authMode is consumer', () => {
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
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
      logLevel: 'INFO',
      port: 8000,
      appUrl: 'http://localhost:1420',
      posthogHost: 'https://us.i.posthog.com',
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
      authMode: 'consumer' as const,
      oidcClientId: '',
      oidcClientSecret: '',
      oidcIssuer: '',
      betterAuthUrl: 'http://localhost:8000',
      betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
      rateLimitEnabled: false,
      swaggerEnabled: false,
      trustedProxy: '',
    })

    const app = new Elysia().use(createOidcConfigRoutes())

    return app.handle(new Request('http://localhost/auth/oidc/config')).then((response) => {
      expect(response.status).toBe(404)
    })
  })

  it('strips path from issuer URL, returning only the origin', () => {
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
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
      logLevel: 'INFO',
      port: 8000,
      appUrl: 'http://localhost:1420',
      posthogHost: 'https://us.i.posthog.com',
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
      oidcClientId: 'test-client-id',
      oidcClientSecret: 'test-client-secret',
      oidcIssuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
      betterAuthUrl: 'http://localhost:8000',
      betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
      rateLimitEnabled: false,
      swaggerEnabled: false,
      trustedProxy: '',
    })

    const app = new Elysia().use(createOidcConfigRoutes())

    return app.handle(new Request('http://localhost/auth/oidc/config')).then(async (response) => {
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ issuerOrigin: 'https://login.microsoftonline.com' })
    })
  })
})
