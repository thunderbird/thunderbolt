/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import { createTestSettings } from '@/test-utils/settings'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createOidcConfigRoutes } from './oidc'

const baseSettings = createTestSettings({
  authMode: 'oidc',
  oidcClientId: 'test-client-id',
  oidcClientSecret: 'test-client-secret',
})

describe('OIDC config route', () => {
  let getSettingsSpy: ReturnType<typeof spyOn>

  afterAll(() => {
    getSettingsSpy?.mockRestore()
  })

  it('returns issuerOrigin when authMode is oidc', () => {
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
      ...baseSettings,
      oidcIssuer: 'https://auth.okta.com/some/path',
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
      ...baseSettings,
      authMode: 'consumer',
    })

    const app = new Elysia().use(createOidcConfigRoutes())

    return app.handle(new Request('http://localhost/auth/oidc/config')).then((response) => {
      expect(response.status).toBe(404)
    })
  })

  it('strips path from issuer URL, returning only the origin', () => {
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
      ...baseSettings,
      oidcIssuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
    })

    const app = new Elysia().use(createOidcConfigRoutes())

    return app.handle(new Request('http://localhost/auth/oidc/config')).then(async (response) => {
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ issuerOrigin: 'https://login.microsoftonline.com' })
    })
  })
})
