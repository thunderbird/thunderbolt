/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mock } from 'bun:test'
import * as authUtils from '@/auth/utils'
import * as waitlistUtils from '@/waitlist/utils'
import * as settingsModule from '@/config/settings'
import { createTestSettings } from '@/test-utils/settings'

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

import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { inflateRawSync } from 'node:zlib'
import * as samlify from 'samlify'
import { getTestCerts } from '../../../e2e/saml-test-certs'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { account, user } from '@/db/auth-schema'
import { and, eq } from 'drizzle-orm'
import { createSessionCookie } from '@/test-utils/session-cookie'
import { ssoProvider } from '@/db/schema'

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
const baseSettings = createTestSettings({
  logLevel: 'ERROR',
  posthogHost: '',
  authMode: 'saml',
  samlEntryPoint: 'http://fake-idp.example.com/saml/sso',
  samlEntityId: 'fake-saml-sp',
  samlIdpIssuer: 'http://fake-idp.example.com',
  samlCert:
    'MIICpDCCAYwCCQDU+pQ4pHgSpDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwHhcNMjQwMTAxMDAwMDAwWhcNMjUwMTAxMDAwMDAwWjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7o4QFMSok',
})

describe('SAML Integration', () => {
  let db: IsolatedTestDb['db']
  let getSettingsSpy: ReturnType<typeof spyOn>

  // SSO mode runs Better Auth in native transactions, which commit through the shared
  // BEGIN/ROLLBACK harness, so this suite uses the isolated instance and unique rows.
  beforeAll(async () => {
    db = (await getSharedIsolatedTestDb()).db
  })

  afterEach(() => {
    getSettingsSpy?.mockRestore()
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

  describe('linking a SAML sign-in to an existing account', () => {
    const callbackURL = 'http://localhost:1420/'
    let idpCert: string
    let idp: ReturnType<typeof samlify.IdentityProvider>

    beforeAll(() => {
      const keys = getTestCerts()
      idpCert = keys.certSingleLine
      idp = samlify.IdentityProvider({
        entityID: baseSettings.samlIdpIssuer,
        signingCert: keys.cert,
        privateKey: keys.privateKey,
        singleSignOnService: [
          { Binding: samlify.Constants.namespace.binding.redirect, Location: baseSettings.samlEntryPoint },
        ],
      })
    })

    beforeEach(() => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({ ...baseSettings, samlCert: idpCert })
    })

    /**
     * Complete a SAML sign-in in which the IdP signs a response for `email`. With `unsolicited`, the response
     * carries no `InResponseTo`, no RelayState and no cookie, as when the login starts from the IdP dashboard.
     */
    const signInThroughIdp = async (email: string, { unsolicited = false } = {}) => {
      const { createAuth } = await import('./auth')
      const app = new Elysia({ prefix: '/v1' }).mount(createAuth(db).handler)
      const start = await app.handle(
        new Request('http://localhost/v1/api/auth/sign-in/sso', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: 'sso', callbackURL }),
        }),
      )
      const idpRedirect = new URL(((await start.json()) as { url: string }).url)
      const cookie = start.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0])
        .join('; ')
      const authnRequest = inflateRawSync(
        Buffer.from(idpRedirect.searchParams.get('SAMLRequest') ?? '', 'base64'),
      ).toString()
      const requestId = authnRequest.match(/ ID="([^"]+)"/)?.[1] ?? ''
      const acsUrl = authnRequest.match(/AssertionConsumerServiceURL="([^"]+)"/)?.[1] ?? ''

      const sp = samlify.ServiceProvider({
        entityID: baseSettings.samlEntityId,
        assertionConsumerService: [{ Binding: samlify.Constants.namespace.binding.post, Location: acsUrl }],
      })
      const { context: samlResponse } = await idp.createLoginResponse(
        sp,
        { extract: unsolicited ? {} : { request: { id: requestId } } },
        'post',
        { email },
      )

      const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' })
      const form = new URLSearchParams({ SAMLResponse: samlResponse })
      if (!unsolicited) {
        headers.set('Cookie', cookie)
        form.set('RelayState', idpRedirect.searchParams.get('RelayState') ?? '')
      }

      const acs = await app.handle(new Request(acsUrl, { method: 'POST', headers, body: form }))
      return acs.headers.get('location')
    }

    const ssoAccountCount = (userId: string) =>
      db.$count(account, and(eq(account.userId, userId), eq(account.providerId, 'sso')))

    const existingUser = async () => {
      const { createAuth } = await import('./auth')
      const auth = createAuth(db)
      const cookie = await createSessionCookie(auth, db)
      return (await auth.api.getSession({ headers: new Headers({ Cookie: cookie }) }))!.user
    }

    it('signs an existing email-OTP user in and links the IdP identity to them', async () => {
      const existing = await existingUser()

      expect(await signInThroughIdp(existing.email)).toBe(callbackURL)
      expect(await ssoAccountCount(existing.id)).toBe(1)
    })

    it('control: leaves an unverified local account with the same email unlinked', async () => {
      const email = `unverified-${crypto.randomUUID()}@example.com`
      const [local] = await db
        .insert(user)
        .values({ id: crypto.randomUUID(), name: 'Unverified', email, emailVerified: false })
        .returning()

      expect(await signInThroughIdp(email)).toContain('error=account_not_linked')
      expect(await ssoAccountCount(local.id)).toBe(0)
    })

    describe('response with no matching login request', () => {
      afterEach(async () => {
        await db.delete(ssoProvider)
      })

      it('is refused by default', async () => {
        const existing = await existingUser()

        const location = await signInThroughIdp(existing.email, { unsolicited: true })

        expect(location).toStartWith(baseSettings.appUrl)
        expect(location).toContain('error=unsolicited_response')
        expect(await ssoAccountCount(existing.id)).toBe(0)
      })

      it('is accepted when SAML_ALLOW_IDP_INITIATED is on', async () => {
        const existing = await existingUser()
        getSettingsSpy.mockReturnValue({ ...baseSettings, samlCert: idpCert, samlAllowIdpInitiated: true })

        expect(await signInThroughIdp(existing.email, { unsolicited: true })).toBe(baseSettings.appUrl)
        expect(await ssoAccountCount(existing.id)).toBe(1)
      })

      it('is refused through a provider row stored in the database', async () => {
        getSettingsSpy.mockReturnValue({ ...baseSettings, samlCert: idpCert, samlAllowIdpInitiated: true })
        const existing = await existingUser()
        const storedProviderId = 'stored-idp'
        // An earlier self-registration could store a row signed with a certificate its owner holds.
        await db.insert(ssoProvider).values({
          id: crypto.randomUUID(),
          providerId: storedProviderId,
          issuer: baseSettings.samlIdpIssuer,
          domain: 'stored-idp.test',
          samlConfig: JSON.stringify({
            issuer: baseSettings.samlEntityId,
            entryPoint: baseSettings.samlEntryPoint,
            cert: idpCert,
            idpMetadata: { entityID: baseSettings.samlIdpIssuer },
          }),
        })

        const { createAuth } = await import('./auth')
        const app = new Elysia({ prefix: '/v1' }).mount(createAuth(db).handler)
        const acsUrl = `http://localhost/v1/api/auth/sso/saml2/sp/acs/${storedProviderId}`
        const sp = samlify.ServiceProvider({
          entityID: baseSettings.samlEntityId,
          assertionConsumerService: [{ Binding: samlify.Constants.namespace.binding.post, Location: acsUrl }],
        })
        const { context: samlResponse } = await idp.createLoginResponse(sp, { extract: {} }, 'post', {
          email: existing.email,
        })

        const res = await app.handle(
          new Request(acsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ SAMLResponse: samlResponse }),
          }),
        )

        expect(res.status).toBe(403)
        expect(
          await db.$count(account, and(eq(account.userId, existing.id), eq(account.providerId, storedProviderId))),
        ).toBe(0)
      })
    })
  })

  describe('SAML configuration validation', () => {
    it('should throw when SAML_ENTRY_POINT is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        samlEntryPoint: '',
      })

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('SAML_ENTRY_POINT')
    })

    it('should throw when SAML_CERT is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        samlCert: '',
      })

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('SAML_CERT')
    })

    it('should throw when SAML_ENTITY_ID is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        samlEntityId: '',
      })

      const { createAuth } = await import('./auth')
      expect(() => createAuth(db)).toThrow('SAML_ENTITY_ID')
    })

    it('should throw when SAML_IDP_ISSUER is missing', async () => {
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
        ...baseSettings,
        samlIdpIssuer: '',
      })

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
      getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(baseSettings)
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
            samlConfig: {
              entryPoint: 'https://attacker.test/saml/sso',
              cert: 'attacker-cert',
              callbackUrl: 'http://localhost/v1/api/auth/sso/saml2/sp/acs/attacker-idp',
              idpMetadata: { entityID: 'https://attacker.test' },
              spMetadata: {},
            },
          }),
        }),
      )

      expect(res.status).toBe(403)
      expect(await db.select().from(ssoProvider)).toHaveLength(0)
    })
  })
})
