/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import { createTestSettings } from '@/test-utils/settings'

import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { and, eq } from 'drizzle-orm'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { account, user } from '@/db/auth-schema'
import { createSessionCookie } from '@/test-utils/session-cookie'
import { ssoProvider } from '@/db/schema'

const oidcIssuerUrl = 'https://oidc.test'

/** Issuer of a provider row left in `sso_provider` by an earlier self-registration. */
const storedIssuerUrl = 'https://stored-idp.test'

/**
 * Issuer carrying a path, the shape Authentik and similar providers publish. A
 * double slash only survives to the wire when the issuer has a path — `betterFetch`
 * collapses one that sits directly after the host — so the trailing-slash test below
 * is only meaningful against an issuer like this one.
 */
const oidcPathIssuerUrl = `${oidcIssuerUrl}/application/o/thunderbolt`

const discoveryDocumentFor = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
})

/** Discovery URLs the stub was asked for, so tests can assert how one was derived. */
const requestedDiscoveryUrls: string[] = []

const oidcDiscoveryFetchImpl = async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : input.toString()
  requestedDiscoveryUrls.push(url)
  const issuer = [oidcIssuerUrl, oidcPathIssuerUrl].find(
    (candidate) => url === `${candidate}/.well-known/openid-configuration`,
  )
  if (!issuer) {
    throw new Error(`Unexpected OIDC request: ${url}`)
  }
  return Response.json(discoveryDocumentFor(issuer))
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

const storedProviderId = 'stored-idp'
const storedOidcConfig = JSON.stringify({
  issuer: storedIssuerUrl,
  clientId: baseSettings.oidcClientId,
  clientSecret: 'stored-secret',
  pkce: true,
})

/** Seed the kind of row `/sso/register` wrote while it was open to any signed-in user. */
const insertStoredProvider = (database: IsolatedTestDb['db'], userId: string | null = null) =>
  database.insert(ssoProvider).values({
    id: crypto.randomUUID(),
    providerId: storedProviderId,
    issuer: storedIssuerUrl,
    domain: 'stored-idp.test',
    userId,
    oidcConfig: storedOidcConfig,
  })

/** Save and restore globalThis.fetch + process.env.TRUSTED_ORIGINS around a test body. */
const withOidcFetch = async <T>(fn: () => Promise<T>, idpFetch: typeof fetch = oidcDiscoveryFetch) => {
  const savedFetch = globalThis.fetch
  const savedOrigins = process.env.TRUSTED_ORIGINS
  globalThis.fetch = idpFetch
  // Trusting both IdPs skips Better Auth's DNS check, which would otherwise resolve them for real.
  process.env.TRUSTED_ORIGINS = `http://localhost:1420,${oidcIssuerUrl},${storedIssuerUrl}`
  requestedDiscoveryUrls.length = 0

  try {
    return await fn()
  } finally {
    globalThis.fetch = savedFetch
    // Assigning undefined would store the string "undefined" on newer Bun.
    if (savedOrigins === undefined) {
      delete process.env.TRUSTED_ORIGINS
    } else {
      process.env.TRUSTED_ORIGINS = savedOrigins
    }
  }
}

describe('OIDC Integration', () => {
  let db: IsolatedTestDb['db']
  let getSettingsSpy: ReturnType<typeof spyOn>

  // SSO mode runs Better Auth in native transactions, which commit through the shared
  // BEGIN/ROLLBACK harness, so this suite uses the isolated instance and unique rows.
  beforeAll(async () => {
    db = (await getSharedIsolatedTestDb()).db
  }, 60_000)

  afterEach(() => {
    getSettingsSpy?.mockRestore()
  })

  /** Sign a fresh verified user in by email code; returns them with their session cookie. */
  const signInByEmailCode = async (auth: Parameters<typeof createSessionCookie>[0]) => {
    const cookie = await createSessionCookie(auth, db)
    const session = await auth.api.getSession({ headers: new Headers({ Cookie: cookie }) })
    return { cookie, user: session!.user }
  }

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

  // Several providers (Authentik among them) publish an issuer URL ending in `/`.
  // OIDC Discovery requires stripping it before appending the well-known path;
  // concatenating produced a double slash and a 404.
  describe('issuer with a trailing slash', () => {
    beforeEach(() => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: `${oidcPathIssuerUrl}/`,
      })
    })

    it('should derive a single-slash discovery URL and still sign in', async () => {
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

        expect(requestedDiscoveryUrls).toEqual([`${oidcPathIssuerUrl}/.well-known/openid-configuration`])
        expect(res.ok).toBe(true)
      })
    })
  })

  describe('linking an SSO sign-in to an existing account', () => {
    const callbackURL = 'http://localhost:1420/'
    let signingKey: CryptoKey
    let publicJwk: JWK

    beforeAll(async () => {
      const keyPair = await generateKeyPair('RS256', { extractable: true })
      signingKey = keyPair.privateKey
      publicJwk = { ...(await exportJWK(keyPair.publicKey)), alg: 'RS256' }
    })

    beforeEach(() => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: oidcIssuerUrl,
      })
    })

    /**
     * Complete an OIDC sign-in in which the IdP vouches for `email` with a signed id_token. Returns
     * where the callback redirects, or the sign-in status when sign-in refuses to start.
     */
    const signInThroughIdp = async (email: string, { providerId = 'sso', issuer = oidcIssuerUrl } = {}) => {
      const idToken = await new SignJWT({ email, name: 'SSO User' })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(issuer)
        .setAudience(baseSettings.oidcClientId)
        .setSubject(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signingKey)
      const discovery = discoveryDocumentFor(issuer)
      const idpFetch = async (...[input]: Parameters<typeof fetch>) => {
        const url = input instanceof Request ? input.url : input.toString()
        if (url === `${issuer}/.well-known/openid-configuration`) {
          return Response.json(discovery)
        }
        if (url === discovery.token_endpoint) {
          return Response.json({ access_token: 'idp-access-token', token_type: 'Bearer', id_token: idToken })
        }
        if (url === discovery.jwks_uri) {
          return Response.json({ keys: [publicJwk] })
        }
        throw new Error(`Unexpected OIDC request: ${url}`)
      }

      return withOidcFetch(
        async () => {
          const { createAuth } = await import('./auth')
          const app = new Elysia({ prefix: '/v1' }).mount(createAuth(db).handler)
          const start = await app.handle(
            new Request('http://localhost/v1/api/auth/sign-in/sso', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ providerId, callbackURL }),
            }),
          )
          if (!start.ok) {
            return start.status
          }
          const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')
          const cookie = start.headers
            .getSetCookie()
            .map((entry) => entry.split(';')[0])
            .join('; ')

          const callback = await app.handle(
            new Request(`http://localhost/v1/api/auth/sso/callback/${providerId}?code=idp-code&state=${state}`, {
              headers: { Cookie: cookie },
            }),
          )
          return callback.headers.get('location')
        },
        Object.assign(idpFetch, { preconnect: globalThis.fetch.preconnect }),
      )
    }

    const ssoAccountCount = (userId: string) =>
      db.$count(account, and(eq(account.userId, userId), eq(account.providerId, 'sso')))

    it('signs an existing email-OTP user in and links the IdP identity to them', async () => {
      const { createAuth } = await import('./auth')
      const { user: existing } = await signInByEmailCode(createAuth(db))

      expect(await signInThroughIdp(existing.email)).toBe(callbackURL)
      expect(await ssoAccountCount(existing.id)).toBe(1)
    })

    it('control: leaves an unverified local account with the same email unlinked', async () => {
      const email = `unverified-${crypto.randomUUID()}@example.com`
      const [local] = await db
        .insert(user)
        .values({ id: crypto.randomUUID(), name: 'Unverified', email, emailVerified: false })
        .returning()

      expect(await signInThroughIdp(email)).toContain('error=account+not+linked')
      expect(await ssoAccountCount(local.id)).toBe(0)
    })

    describe('through a provider row stored in the database', () => {
      const storedIdp = { providerId: storedProviderId, issuer: storedIssuerUrl }

      beforeEach(async () => {
        await insertStoredProvider(db)
      })

      afterEach(async () => {
        await db.delete(ssoProvider)
      })

      it('refuses to sign an existing verified user in', async () => {
        const { createAuth } = await import('./auth')
        const { user: existing } = await signInByEmailCode(createAuth(db))

        expect(await signInThroughIdp(existing.email, storedIdp)).toBe(403)
        expect(
          await db.$count(account, and(eq(account.userId, existing.id), eq(account.providerId, storedProviderId))),
        ).toBe(0)
      })

      it('refuses to create a new user', async () => {
        const email = `newcomer-${crypto.randomUUID()}@example.com`

        expect(await signInThroughIdp(email, storedIdp)).toBe(403)
        expect(await db.$count(user, eq(user.email, email))).toBe(0)
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

  describe('SSO provider self-registration', () => {
    beforeEach(() => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: oidcIssuerUrl,
      })
    })

    afterEach(async () => {
      await db.delete(ssoProvider)
    })

    it('refuses an ordinary session and stores no provider', async () => {
      const { createAuth } = await import('./auth')
      const auth = createAuth(db)
      const app = new Elysia({ prefix: '/v1' }).mount(auth.handler)
      const cookie = await createSessionCookie(auth, db)

      const res = await app.handle(
        new Request('http://localhost/v1/api/auth/sso/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            providerId: 'attacker-idp',
            issuer: 'https://attacker.test',
            domain: 'attacker.test',
            oidcConfig: {
              clientId: 'attacker-client',
              clientSecret: 'attacker-secret',
              skipDiscovery: true,
              authorizationEndpoint: 'https://attacker.test/authorize',
              tokenEndpoint: 'http://169.254.169.254/token',
              jwksEndpoint: 'http://169.254.169.254/jwks',
            },
          }),
        }),
      )

      expect(res.status).toBe(403)
      expect(await db.select().from(ssoProvider)).toHaveLength(0)
    })

    it('refuses the owner of a stored provider row an edit', async () => {
      const { createAuth } = await import('./auth')
      const auth = createAuth(db)
      const app = new Elysia({ prefix: '/v1' }).mount(auth.handler)
      const { cookie, user: owner } = await signInByEmailCode(auth)
      await insertStoredProvider(db, owner.id)

      const res = await app.handle(
        new Request('http://localhost/v1/api/auth/sso/update-provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            providerId: storedProviderId,
            oidcConfig: { tokenEndpoint: 'https://elsewhere.example.com/token' },
          }),
        }),
      )

      expect(res.status).toBe(403)
      const [stored] = await db.select().from(ssoProvider).where(eq(ssoProvider.providerId, storedProviderId))
      expect(stored?.oidcConfig).toBe(storedOidcConfig)
    })
  })
})
