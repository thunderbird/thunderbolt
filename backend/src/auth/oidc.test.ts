/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import type { Settings } from '@/config/settings'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createOidcConfigRoutes } from './oidc'

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
  authMode: 'oidc',
  oidcClientId: 'test-client-id',
  oidcClientSecret: 'test-client-secret',
  oidcIssuer: '',
  betterAuthUrl: 'http://localhost:8000',
  betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
  rateLimitEnabled: false,
  swaggerEnabled: false,
  trustedProxy: '',
  e2eeEnabled: false,
  samlEntryPoint: '',
  samlEntityId: '',
  samlIdpIssuer: '',
  samlCert: '',
}

describe('OIDC config route', () => {
  let getSettingsSpy: ReturnType<typeof spyOn>

  afterAll(() => {
    getSettingsSpy?.mockRestore()
  })

  it('returns issuerOrigin when authMode is oidc', () => {
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
      ...baseSettings,
      oidcIssuer: 'https://auth.okta.com/some/path',
    } as Settings)

    const app = new Elysia().use(createOidcConfigRoutes())

    return app.handle(new Request('http://localhost/auth/oidc/config')).then(async (response) => {
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ issuerOrigin: 'https://auth.okta.com' })
    })
  })

  it('returns 404 when authMode is consumer', () => {
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
      ...baseSettings,
      authMode: 'consumer',
    } as Settings)

    const app = new Elysia().use(createOidcConfigRoutes())

    return app.handle(new Request('http://localhost/auth/oidc/config')).then((response) => {
      expect(response.status).toBe(404)
    })
  })

  it('strips path from issuer URL, returning only the origin', () => {
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
      ...baseSettings,
      oidcIssuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
    } as Settings)

    const app = new Elysia().use(createOidcConfigRoutes())

    return app.handle(new Request('http://localhost/auth/oidc/config')).then(async (response) => {
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ issuerOrigin: 'https://login.microsoftonline.com' })
    })
  })
})
