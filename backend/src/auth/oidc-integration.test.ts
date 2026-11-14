/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import { createTestSettings } from '@/test-utils/settings'

import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { and, eq, inArray } from 'drizzle-orm'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { account, user } from '@/db/auth-schema'
import { createSessionCookie } from '@/test-utils/session-cookie'
import {
  auditEvent,
  identityConnection,
  memberRoleGrant,
  membershipSource,
  orgMembership,
  scimSubject,
  scimUser,
  ssoProvider,
} from '@/db/schema'
import { sso } from '@better-auth/sso'
import { createSsoConnection, ensureEnvSsoConnection, envSsoConnectionId } from '@/identity/sso-connections'
import { getCurrentOrganizationId } from '@/identity/current-organization'

const oidcIssuerUrl = 'https://oidc.test'

/** Issuer of a second connection, created as an admin would, next to the env one. */
const secondIssuerUrl = 'https://keycloak.test'

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
  process.env.TRUSTED_ORIGINS = `http://localhost:1420,${oidcIssuerUrl},${secondIssuerUrl},${storedIssuerUrl}`
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

  /** Write the env provider and its connection, as boot does: SSO sign-in finds providers only through one. */
  const seedEnvConnection = () => ensureEnvSsoConnection(db, settingsModule.getSettings())

  /** Sign a fresh verified user in by email code; returns them with their session cookie. */
  const signInByEmailCode = async (auth: Parameters<typeof createSessionCookie>[0]) => {
    const cookie = await createSessionCookie(auth, db)
    const session = await auth.api.getSession({ headers: new Headers({ Cookie: cookie }) })
    return { cookie, user: session!.user }
  }

  describe('OIDC sign-in endpoint', () => {
    beforeEach(async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: oidcIssuerUrl,
      })
      await seedEnvConnection()
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
    // Such a provider publishes the slash in its discovery document too, and Better Auth requires the
    // discovered issuer to match the configured one exactly.
    const trailingSlashIdpFetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString()
        requestedDiscoveryUrls.push(url)
        if (url !== `${oidcPathIssuerUrl}/.well-known/openid-configuration`) {
          throw new Error(`Unexpected OIDC request: ${url}`)
        }
        return Response.json({ ...discoveryDocumentFor(oidcPathIssuerUrl), issuer: `${oidcPathIssuerUrl}/` })
      },
      { preconnect: () => {} },
    ) as unknown as typeof fetch

    beforeEach(async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: `${oidcPathIssuerUrl}/`,
      })
      await seedEnvConnection()
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
      }, trailingSlashIdpFetch)
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

    beforeEach(async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: oidcIssuerUrl,
      })
      await seedEnvConnection()
    })

    /**
     * Complete an OIDC sign-in in which the IdP vouches for `email` with a signed id_token carrying
     * `claims`. Returns the final status, where the callback redirects and whose session it set.
     */
    const signInThroughIdp = async (
      email: string,
      options: {
        providerId?: string
        issuer?: string
        claims?: { email_verified?: boolean | string }
        subject?: string
      } = {},
    ) => {
      const {
        providerId = 'sso',
        issuer = oidcIssuerUrl,
        claims = { email_verified: true },
        subject = crypto.randomUUID(),
      } = options
      const idToken = await new SignJWT({ email, name: 'SSO User', ...claims })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(issuer)
        .setAudience(baseSettings.oidcClientId)
        .setSubject(subject)
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

      const cookieOf = (response: Response) =>
        response.headers
          .getSetCookie()
          .map((entry) => entry.split(';')[0])
          .join('; ')

      return withOidcFetch(
        async () => {
          const { createAuth } = await import('./auth')
          const auth = createAuth(db)
          const app = new Elysia({ prefix: '/v1' }).mount(auth.handler)
          const start = await app.handle(
            new Request('http://localhost/v1/api/auth/sign-in/sso', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ providerId, callbackURL }),
            }),
          )
          if (!start.ok) {
            return { status: start.status, location: null, sessionUserId: undefined }
          }
          const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')

          const callback = await app.handle(
            new Request(`http://localhost/v1/api/auth/sso/callback/${providerId}?code=idp-code&state=${state}`, {
              headers: { Cookie: cookieOf(start) },
            }),
          )
          const session = await auth.api.getSession({ headers: new Headers({ Cookie: cookieOf(callback) }) })
          return {
            status: callback.status,
            location: callback.headers.get('location'),
            sessionUserId: session?.user.id,
          }
        },
        Object.assign(idpFetch, { preconnect: globalThis.fetch.preconnect }),
      )
    }

    const ssoAccountCount = (userId: string) =>
      db.$count(account, and(eq(account.userId, userId), eq(account.providerId, 'sso')))

    it('signs an existing email-OTP user in and links the IdP identity to them', async () => {
      const { createAuth } = await import('./auth')
      const { user: existing } = await signInByEmailCode(createAuth(db))

      const { location, sessionUserId } = await signInThroughIdp(existing.email)
      expect(location).toBe(callbackURL)
      expect(sessionUserId).toBe(existing.id)
      expect(await ssoAccountCount(existing.id)).toBe(1)
    })

    it('links an existing email-OTP user when the IdP sends no email_verified claim, as Entra does', async () => {
      const { createAuth } = await import('./auth')
      const { user: existing } = await signInByEmailCode(createAuth(db))

      const { location, sessionUserId } = await signInThroughIdp(existing.email, { claims: {} })
      expect(location).toBe(callbackURL)
      expect(sessionUserId).toBe(existing.id)
      expect(await ssoAccountCount(existing.id)).toBe(1)
    })

    it('control: leaves an unverified local account with the same email unlinked', async () => {
      const email = `unverified-${crypto.randomUUID()}@example.com`
      const [local] = await db
        .insert(user)
        .values({ id: crypto.randomUUID(), name: 'Unverified', email, emailVerified: false })
        .returning()

      expect((await signInThroughIdp(email)).location).toContain('error=account+not+linked')
      expect(await ssoAccountCount(local.id)).toBe(0)
    })

    it('links a new IdP identity to a user the provider signed up before', async () => {
      const email = `sso-user-${crypto.randomUUID()}@example.com`
      expect((await signInThroughIdp(email)).location).toBe(callbackURL)
      const [ssoUser] = await db.select().from(user).where(eq(user.email, email))
      expect(ssoUser.emailVerified).toBe(false)

      // Each sign-in carries a new subject, as after moving IdP or switching between OIDC and SAML.
      const { location, sessionUserId } = await signInThroughIdp(email)
      expect(sessionUserId).toBe(ssoUser.id)
      expect(location).toBe(callbackURL)
      expect(await ssoAccountCount(ssoUser.id)).toBe(2)
    })

    it.each([false, 'false'])(
      'leaves a verified user unlinked when the IdP says email_verified is %p',
      async (emailVerified) => {
        const { createAuth } = await import('./auth')
        const { user: existing } = await signInByEmailCode(createAuth(db))

        const { location } = await signInThroughIdp(existing.email, { claims: { email_verified: emailVerified } })
        expect(location).toContain('error=account+not+linked')
        expect(await ssoAccountCount(existing.id)).toBe(0)
      },
    )

    it.each([
      { emailVerified: true, granted: true },
      { emailVerified: false, granted: false },
    ])(
      'grants a bootstrap admin email admin at its first SSO sign-in only when the IdP does not deny email_verified (%p)',
      async ({ emailVerified, granted }) => {
        const email = `bootstrap-${crypto.randomUUID()}@example.com`
        getSettingsSpy.mockReturnValue({ ...baseSettings, oidcIssuer: oidcIssuerUrl, bootstrapAdminEmails: email })

        const { sessionUserId } = await signInThroughIdp(email, { claims: { email_verified: emailVerified } })

        expect(sessionUserId).toBeString()
        const grants = await db
          .select({ role: memberRoleGrant.role })
          .from(memberRoleGrant)
          .innerJoin(orgMembership, eq(orgMembership.id, memberRoleGrant.membershipId))
          .where(eq(orgMembership.userId, sessionUserId!))
        expect(grants).toEqual(granted ? [{ role: 'admin' }] : [])
      },
    )

    it("signs a returning identity in to its own user after the IdP moves it to another user's email", async () => {
      const { createAuth } = await import('./auth')
      const { user: other } = await signInByEmailCode(createAuth(db))
      const subject = crypto.randomUUID()
      const email = `mover-${crypto.randomUUID()}@example.com`
      expect((await signInThroughIdp(email, { subject })).location).toBe(callbackURL)
      const [mover] = await db.select().from(user).where(eq(user.email, email))

      const { location, sessionUserId } = await signInThroughIdp(other.email, { subject })
      expect(sessionUserId).toBe(mover.id)
      expect(location).toBe(callbackURL)
      expect(await ssoAccountCount(other.id)).toBe(0)
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

        expect((await signInThroughIdp(existing.email, storedIdp)).status).toBe(403)
        expect(
          await db.$count(account, and(eq(account.userId, existing.id), eq(account.providerId, storedProviderId))),
        ).toBe(0)
      })

      it('refuses to create a new user', async () => {
        const email = `newcomer-${crypto.randomUUID()}@example.com`

        expect((await signInThroughIdp(email, storedIdp)).status).toBe(403)
        expect(await db.$count(user, eq(user.email, email))).toBe(0)
      })
    })
  })

  describe('several SSO connections', () => {
    const callbackURL = 'http://localhost:1420/'
    const secondProviderId = 'keycloak'
    let signingKey: CryptoKey
    let publicJwk: JWK
    let secondConnectionId: string

    beforeAll(async () => {
      const keyPair = await generateKeyPair('RS256', { extractable: true })
      signingKey = keyPair.privateKey
      publicJwk = { ...(await exportJWK(keyPair.publicKey)), alg: 'RS256' }
    })

    beforeEach(async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: oidcIssuerUrl,
      })
      await seedEnvConnection()
      secondConnectionId = await createSsoConnection(db, {
        name: 'Keycloak',
        providerId: secondProviderId,
        protocol: {
          oidc: { issuer: secondIssuerUrl, clientId: baseSettings.oidcClientId, clientSecret: 'keycloak-secret' },
        },
      })
    })

    afterEach(async () => {
      const connectionIds = [secondConnectionId]
      await db.delete(membershipSource).where(inArray(membershipSource.identityConnectionId, connectionIds))
      await db.delete(identityConnection).where(inArray(identityConnection.id, connectionIds))
      await db.delete(ssoProvider).where(eq(ssoProvider.providerId, secondProviderId))
    })

    /** Complete an OIDC sign-in through `providerId`, whose IdP vouches for `email`. */
    const signIn = async (
      providerId: string,
      email: string,
      { subject = crypto.randomUUID(), claims = { email_verified: true } as Record<string, unknown> } = {},
    ) => {
      const issuer = providerId === secondProviderId ? secondIssuerUrl : oidcIssuerUrl
      const idToken = await new SignJWT({ email, name: 'SSO User', ...claims })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(issuer)
        .setAudience(baseSettings.oidcClientId)
        .setSubject(subject)
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
      const cookieOf = (response: Response) =>
        response.headers
          .getSetCookie()
          .map((entry) => entry.split(';')[0])
          .join('; ')

      return withOidcFetch(
        async () => {
          const { createAuth } = await import('./auth')
          const auth = createAuth(db)
          const app = new Elysia({ prefix: '/v1' }).mount(auth.handler)
          const start = await app.handle(
            new Request('http://localhost/v1/api/auth/sign-in/sso', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ providerId, callbackURL }),
            }),
          )
          if (!start.ok) {
            return { status: start.status, authorizeUrl: null, location: null, sessionUserId: undefined }
          }
          const authorizeUrl = new URL(((await start.json()) as { url: string }).url)
          const callback = await app.handle(
            new Request(
              `http://localhost/v1/api/auth/sso/callback/${providerId}?code=idp-code&state=${authorizeUrl.searchParams.get('state')}`,
              { headers: { Cookie: cookieOf(start) } },
            ),
          )
          const session = await auth.api.getSession({ headers: new Headers({ Cookie: cookieOf(callback) }) })
          return {
            status: callback.status,
            authorizeUrl,
            location: callback.headers.get('location'),
            sessionUserId: session?.user.id,
          }
        },
        Object.assign(idpFetch, { preconnect: globalThis.fetch.preconnect }),
      )
    }

    const pairWithScim = (status: 'active' | 'scim_retiring' | 'scim_retired' = 'active') =>
      db
        .update(identityConnection)
        .set({ scimConnectionId: `scim-${crypto.randomUUID()}`, status })
        .where(eq(identityConnection.id, secondConnectionId))

    const sourcesOf = (userId: string) =>
      db
        .select({ kind: membershipSource.kind, connectionId: membershipSource.identityConnectionId })
        .from(membershipSource)
        .innerJoin(orgMembership, eq(orgMembership.id, membershipSource.membershipId))
        .where(eq(orgMembership.userId, userId))

    const userCount = (email: string) => db.$count(user, eq(user.email, email))

    /** A member SCIM provisioned on the second connection, who already signed in through it once. */
    const insertScimMember = async (subject: string) => {
      const email = `scim-${crypto.randomUUID()}@example.com`
      const [member] = await db
        .insert(user)
        .values({ id: crypto.randomUUID(), name: 'SCIM User', email, emailVerified: true })
        .returning()
      const [membership] = await db
        .insert(orgMembership)
        .values({ id: crypto.randomUUID(), orgId: getCurrentOrganizationId(), userId: member.id })
        .returning()
      await db.insert(membershipSource).values({
        id: crypto.randomUUID(),
        orgId: getCurrentOrganizationId(),
        membershipId: membership.id,
        kind: 'scim',
        identityConnectionId: secondConnectionId,
      })
      await db.insert(account).values({
        id: crypto.randomUUID(),
        accountId: subject,
        providerId: secondProviderId,
        userId: member.id,
        updatedAt: new Date(),
      })
      return { member, membership }
    }

    it('sends each connection to its own IdP and admits each subject through its own connection', async () => {
      const envEmail = `entra-${crypto.randomUUID()}@example.com`
      const secondEmail = `keycloak-${crypto.randomUUID()}@example.com`

      const viaEnv = await signIn('sso', envEmail)
      const viaSecond = await signIn(secondProviderId, secondEmail)

      expect(viaEnv.authorizeUrl?.origin).toBe(oidcIssuerUrl)
      expect(viaSecond.authorizeUrl?.origin).toBe(secondIssuerUrl)
      expect(viaEnv.location).toBe(callbackURL)
      expect(viaSecond.location).toBe(callbackURL)
      expect(await sourcesOf(viaEnv.sessionUserId!)).toEqual([{ kind: 'sso', connectionId: envSsoConnectionId }])
      expect(await sourcesOf(viaSecond.sessionUserId!)).toEqual([{ kind: 'sso', connectionId: secondConnectionId }])
      expect(
        await db.$count(
          account,
          and(eq(account.userId, viaSecond.sessionUserId!), eq(account.providerId, secondProviderId)),
        ),
      ).toBe(1)
    })

    it('creates no user for an unprovisioned subject when the connection requires a SCIM record', async () => {
      await pairWithScim()
      const email = `unprovisioned-${crypto.randomUUID()}@example.com`

      const { location, sessionUserId } = await signIn(secondProviderId, email)

      expect(location).toContain('error=ACCESS_NOT_MEMBER')
      expect(sessionUserId).toBeUndefined()
      expect(await userCount(email)).toBe(0)
    })

    it('never links a SCIM connection subject to a verified user by email', async () => {
      await pairWithScim()
      const { createAuth } = await import('./auth')
      const { user: existing } = await signInByEmailCode(createAuth(db))

      const { sessionUserId } = await signIn(secondProviderId, existing.email)

      expect(sessionUserId).toBeUndefined()
      expect(
        await db.$count(account, and(eq(account.userId, existing.id), eq(account.providerId, secondProviderId))),
      ).toBe(0)
    })

    it.each([
      { emailVerified: true, admitted: true },
      { emailVerified: false, admitted: false },
    ])(
      'admits a bootstrap admin email on a SCIM connection before SCIM provisions it, only when verified (%p)',
      async ({ emailVerified, admitted }) => {
        await pairWithScim()
        const email = `bootstrap-${crypto.randomUUID()}@example.com`
        getSettingsSpy.mockReturnValue({ ...baseSettings, oidcIssuer: oidcIssuerUrl, bootstrapAdminEmails: email })

        const { sessionUserId } = await signIn(secondProviderId, email, { claims: { email_verified: emailVerified } })

        if (!admitted) {
          expect(sessionUserId).toBeUndefined()
          expect(await userCount(email)).toBe(0)
          return
        }
        expect(await sourcesOf(sessionUserId!)).toEqual([{ kind: 'bootstrap', connectionId: null }])
      },
    )

    it('refuses an unlisted address on a SCIM connection even with bootstrap admins configured', async () => {
      await pairWithScim()
      getSettingsSpy.mockReturnValue({
        ...baseSettings,
        oidcIssuer: oidcIssuerUrl,
        bootstrapAdminEmails: 'someone-else@example.com',
      })
      const email = `unlisted-${crypto.randomUUID()}@example.com`

      expect((await signIn(secondProviderId, email)).location).toContain('error=ACCESS_NOT_MEMBER')
      expect(await userCount(email)).toBe(0)
    })

    it.each(['scim_retiring', 'scim_retired'] as const)(
      'admits a first login once the SCIM side is %s',
      async (status) => {
        await pairWithScim(status)
        const email = `after-retirement-${crypto.randomUUID()}@example.com`

        const { sessionUserId } = await signIn(secondProviderId, email)

        expect(await sourcesOf(sessionUserId!)).toEqual([{ kind: 'sso', connectionId: secondConnectionId }])
      },
    )

    it.each(['scim_retiring', 'scim_retired'] as const)(
      'lets a SCIM-provisioned member in through the SSO side once the SCIM side is %s',
      async (status) => {
        const subject = crypto.randomUUID()
        const { member } = await insertScimMember(subject)
        await pairWithScim(status)

        const { location, sessionUserId } = await signIn(secondProviderId, member.email, { subject })

        expect(location).toBe(callbackURL)
        expect(sessionUserId).toBe(member.id)
        expect(await sourcesOf(member.id)).toContainEqual({ kind: 'sso', connectionId: secondConnectionId })
        expect(
          await db.$count(
            auditEvent,
            and(eq(auditEvent.action, 'member.source_added'), eq(auditEvent.targetId, member.id)),
          ),
        ).toBe(1)
      },
    )

    it('still refuses a blocked member after the SCIM side is retired', async () => {
      const subject = crypto.randomUUID()
      const { member, membership } = await insertScimMember(subject)
      await db.update(orgMembership).set({ blockedAt: new Date() }).where(eq(orgMembership.id, membership.id))
      await pairWithScim('scim_retired')

      const { location, sessionUserId } = await signIn(secondProviderId, member.email, { subject })

      expect(location).toContain('error=ACCESS_BLOCKED')
      expect(sessionUserId).toBeUndefined()
    })

    it('never email-links an SSO-only connection subject to a user a SCIM connection manages', async () => {
      const { member } = await insertScimMember(crypto.randomUUID())

      const { sessionUserId } = await signIn('sso', member.email)

      expect(sessionUserId).toBeUndefined()
      expect(await db.$count(account, and(eq(account.userId, member.id), eq(account.providerId, 'sso')))).toBe(0)
    })

    it.each(['scimSubject', 'scimUser'] as const)(
      'never email-links to a user the SCIM plugin linked (%s) before any membership source exists',
      async (table) => {
        const email = `scim-created-${crypto.randomUUID()}@example.com`
        const [created] = await db
          .insert(user)
          .values({ id: crypto.randomUUID(), name: 'SCIM Created', email, emailVerified: true })
          .returning()
        const now = new Date()
        if (table === 'scimSubject') {
          await db
            .insert(scimSubject)
            .values({ id: crypto.randomUUID(), userId: created.id, revision: 1, createdAt: now, updatedAt: now })
        } else {
          const key = crypto.randomUUID()
          await db.insert(scimUser).values({
            id: crypto.randomUUID(),
            connectionId: 'scim-entra',
            provisioningDomainId: getCurrentOrganizationId(),
            userId: created.id,
            connectionUserKey: key,
            userName: email,
            userNameKey: `name-${key}`,
            primaryEmail: email,
            workEmailValueIndex: email,
            emailValueIndex: email,
            displayName: 'SCIM Created',
            formattedName: 'SCIM Created',
            serializedEmails: '[]',
            active: true,
            orderKey: `order-${key}`,
            createdAt: now,
            updatedAt: now,
          })
        }

        try {
          const { sessionUserId } = await signIn('sso', email)

          expect(sessionUserId).toBeUndefined()
          expect(await db.$count(account, and(eq(account.userId, created.id), eq(account.providerId, 'sso')))).toBe(0)
        } finally {
          // A half-built SCIM link left in the shared database breaks the SCIM suite's decommission walk.
          await db.delete(user).where(eq(user.id, created.id))
        }
      },
    )

    it('refuses sign-in and callbacks on a retired connection', async () => {
      await db
        .update(identityConnection)
        .set({ status: 'retired' })
        .where(eq(identityConnection.id, secondConnectionId))

      expect((await signIn(secondProviderId, `retired-${crypto.randomUUID()}@example.com`)).status).toBe(403)
    })

    it('refuses a sign-in that names no provider', async () => {
      await withOidcFetch(async () => {
        const { createAuth } = await import('./auth')
        const app = new Elysia({ prefix: '/v1' }).mount(createAuth(db).handler)

        const res = await app.handle(
          new Request('http://localhost/v1/api/auth/sign-in/sso', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'someone@keycloak.test', callbackURL }),
          }),
        )

        expect(res.status).toBe(403)
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
    beforeEach(async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        oidcIssuer: oidcIssuerUrl,
      })
      await seedEnvConnection()
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
      expect(await db.$count(ssoProvider, eq(ssoProvider.providerId, 'attacker-idp'))).toBe(0)
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

    it('refuses a callback for any other provider', async () => {
      const { createAuth } = await import('./auth')
      const app = new Elysia({ prefix: '/v1' }).mount(createAuth(db).handler)
      await insertStoredProvider(db)

      const res = await app.handle(
        new Request(`http://localhost/v1/api/auth/sso/callback/${storedProviderId}?code=idp-code&state=any-state`),
      )

      expect(res.status).toBe(403)
    })

    it('keeps every SSO plugin route behind the provider check', () => {
      // isForeignSsoRequest only inspects these prefixes, so a route outside them would skip the check.
      const paths = Object.values(sso({ providersLimit: 0 }).endpoints).map((endpoint) => endpoint.path)

      expect(paths.filter((path) => path !== '/sign-in/sso' && !path.startsWith('/sso/'))).toEqual([])
    })
  })
})
