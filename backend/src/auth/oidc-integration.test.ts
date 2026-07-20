/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import { createTestSettings } from '@/test-utils/settings'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createTestDb } from '@/test-utils/db'

const oidcIssuerUrl = 'https://oidc.test'

const oidcDiscoveryFetchImpl = async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : input.toString()
  if (url !== `${oidcIssuerUrl}/.well-known/openid-configuration`) {
    throw new Error(`Unexpected OIDC request: ${url}`)
  }
  return Response.json({
    issuer: oidcIssuerUrl,
    authorization_endpoint: `${oidcIssuerUrl}/authorize`,
    token_endpoint: `${oidcIssuerUrl}/token`,
    jwks_uri: `${oidcIssuerUrl}/jwks`,
  })
}
const oidcDiscoveryFetch = Object.assign(oidcDiscoveryFetchImpl, { preconnect: () => {} }) as unknown as typeof fetch

/** Base settings for OIDC tests — issuer URL is overridden per-suite */
const baseSettings = createTestSettings({
  logLevel: 'ERROR',
  posthogHost: '',
  authMode: 'oidc',
  oidcClientId: 'thunderbolt-app',
  oidcClientSecret: 'thunderbolt-dev-secret',
})

/** Save and restore globalThis.fetch + process.env.TRUSTED_ORIGINS around a test body. */
const withOidcFetch = async (fn: () => Promise<void>) => {
  const savedFetch = globalThis.fetch
  const savedOrigins = process.env.TRUSTED_ORIGINS
  globalThis.fetch = oidcDiscoveryFetch
  process.env.TRUSTED_ORIGINS = `http://localhost:1420,${oidcIssuerUrl}`

  try {
    await fn()
  } finally {
    globalThis.fetch = savedFetch
    process.env.TRUSTED_ORIGINS = savedOrigins
  }
}

describe('OIDC Integration', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let getSettingsSpy: ReturnType<typeof spyOn>

  beforeAll(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  }, 60_000)

  afterAll(async () => {
    if (cleanup) {
      await cleanup().catch(() => {})
    }
  }, 60_000)

  afterEach(() => {
    getSettingsSpy?.mockRestore()
  })

  describe('OIDC sign-in endpoint', () => {
    beforeEach(() => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: oidcIssuerUrl,
      })
    })

    it('should return a redirect URL pointing to the OIDC provider', async () => {
      await withOidcFetch(async () => {
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
      await withOidcFetch(async () => {
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
      await withOidcFetch(async () => {
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
      })

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('OIDC_ISSUER')
    })

    it('should throw when OIDC_CLIENT_ID is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: 'https://idp.example.com',
        oidcClientId: '',
        oidcClientSecret: 'some-secret',
      })

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('OIDC_CLIENT_ID')
    })

    it('should throw when OIDC_CLIENT_SECRET is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: 'https://idp.example.com',
        oidcClientId: 'some-client',
        oidcClientSecret: '',
      })

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
      })

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
