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
     * Start a SAML login in a fresh browser and sign the response for `email`. An unsolicited response
     * has no `InResponseTo`, as when the login starts from the IdP dashboard.
     */
    const startLogin = async (email: string, { unsolicited = false, assertionOnly = false } = {}) => {
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
      const setCookies = start.headers.getSetCookie()
      const cookie = setCookies.map((entry) => entry.split(';')[0]).join('; ')
      const authnRequest = inflateRawSync(
        Buffer.from(idpRedirect.searchParams.get('SAMLRequest') ?? '', 'base64'),
      ).toString()
      const requestId = authnRequest.match(/ ID="([^"]+)"/)?.[1] ?? ''
      const acsUrl = authnRequest.match(/AssertionConsumerServiceURL="([^"]+)"/)?.[1] ?? ''

      // samlify signs only the assertion for an SP that wants assertions signed, else the whole Response.
      const sp = samlify.ServiceProvider({
        entityID: baseSettings.samlEntityId,
        wantAssertionsSigned: assertionOnly,
        assertionConsumerService: [{ Binding: samlify.Constants.namespace.binding.post, Location: acsUrl }],
      })
      const { context: samlResponse } = await idp.createLoginResponse(
        sp,
        { extract: unsolicited ? {} : { request: { id: requestId } } },
        'post',
        { email },
      )
      return {
        app,
        acsUrl,
        setCookies,
        cookie,
        relayState: idpRedirect.searchParams.get('RelayState') ?? '',
        samlResponse,
      }
    }

    type Login = Awaited<ReturnType<typeof startLogin>>

    /** Submit a signed response to the ACS, optionally with a Cookie header. */
    const postToAcs = (login: Login, { cookie, relayState }: { cookie?: string; relayState?: string }) => {
      const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' })
      const form = new URLSearchParams({ SAMLResponse: login.samlResponse })
      if (cookie) {
        headers.set('Cookie', cookie)
      }
      if (relayState) {
        form.set('RelayState', relayState)
      }
      return login.app.handle(new Request(login.acsUrl, { method: 'POST', headers, body: form }))
    }

    /** Complete a SAML login in one browser. Unsolicited responses have no RelayState or cookie. */
    const signInThroughIdp = async (email: string, { unsolicited = false } = {}) => {
      const login = await startLogin(email, { unsolicited })
      const acs = await postToAcs(login, unsolicited ? {} : login)
      return acs.headers.get('location')
    }

    /** Build one browser's Cookie header after sequential logins, replacing earlier cookies with the same name. */
    const cookieJar = (...logins: Login[]) =>
      [
        ...new Map(
          logins.flatMap((login) =>
            login.setCookies.map((entry) => entry.split(';')[0].split('=') as [string, string]),
          ),
        ),
      ]
        .map(([name, value]) => `${name}=${value}`)
        .join('; ')

    const setsSession = (response: Response) =>
      response.headers.getSetCookie().some((entry) => entry.includes('session_token=') && !entry.includes('Max-Age=0'))

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

    const attackerLogin = () => startLogin(`attacker-${crypto.randomUUID()}@example.com`)

    describe('response from a login another browser started', () => {
      it('is refused in a victim browser holding no cookie', async () => {
        const attacker = await attackerLogin()

        const acs = await postToAcs(attacker, { relayState: attacker.relayState })

        expect(acs.headers.get('location')).toBe(`${baseSettings.appUrl}/?error=unsolicited_response`)
        expect(setsSession(acs)).toBe(false)
      })

      it('is refused in a victim browser that has its own login under way, which still completes', async () => {
        const victimEmail = `victim-${crypto.randomUUID()}@example.com`
        const victim = await startLogin(victimEmail)
        const attacker = await attackerLogin()

        const forged = await postToAcs(attacker, { cookie: victim.cookie, relayState: attacker.relayState })
        expect(forged.headers.get('location')).toContain('error=unsolicited_response')
        expect(setsSession(forged)).toBe(false)

        const own = await postToAcs(victim, victim)
        expect(own.headers.get('location')).toBe(callbackURL)
        expect(setsSession(own)).toBe(true)
      })

      it('is refused with its RelayState stripped, though its InResponseTo is still valid', async () => {
        const attacker = await attackerLogin()

        const acs = await postToAcs(attacker, {})

        expect(acs.headers.get('location')).toContain('error=unsolicited_response')
        expect(setsSession(acs)).toBe(false)
      })
    })

    describe('when IdP-initiated login is enabled', () => {
      beforeEach(() => {
        getSettingsSpy.mockReturnValue({ ...baseSettings, samlCert: idpCert, samlAllowIdpInitiated: true })
      })

      it('still refuses a response whose RelayState this browser holds no cookie for', async () => {
        const attacker = await attackerLogin()

        const acs = await postToAcs(attacker, { relayState: attacker.relayState })

        expect(acs.headers.get('location')).toContain('error=unsolicited_response')
        expect(setsSession(acs)).toBe(false)
      })

      it('signs in a response that started in this browser and was signed on the assertion only', async () => {
        const login = await startLogin(`assertion-${crypto.randomUUID()}@example.com`, { assertionOnly: true })

        expect(setsSession(await postToAcs(login, login))).toBe(true)
      })

      // The opt-in accepts responses without RelayState, including stripped SP responses. These tests
      // record that residual login-CSRF risk.
      it("accepts another browser's response with RelayState stripped, the opt-in's risk", async () => {
        const attacker = await attackerLogin()

        expect(setsSession(await postToAcs(attacker, {}))).toBe(true)
      })

      it('accepts an assertion-only response with RelayState and the Response InResponseTo stripped', async () => {
        const attacker = await startLogin(`attacker-${crypto.randomUUID()}@example.com`, { assertionOnly: true })
        const xml = Buffer.from(attacker.samlResponse, 'base64').toString()
        const edited = xml.replace(/(<samlp:Response[^>]*?) InResponseTo="[^"]*"/, '$1')
        expect(edited).not.toBe(xml)

        const acs = await postToAcs({ ...attacker, samlResponse: Buffer.from(edited).toString('base64') }, {})

        expect(setsSession(acs)).toBe(true)
      })
    })

    it('completes both logins a browser started in two tabs', async () => {
      const first = await startLogin(`tab-one-${crypto.randomUUID()}@example.com`)
      const second = await startLogin(`tab-two-${crypto.randomUUID()}@example.com`)
      const browser = cookieJar(first, second)

      const firstAcs = await postToAcs(first, { cookie: browser, relayState: first.relayState })
      const secondAcs = await postToAcs(second, { cookie: browser, relayState: second.relayState })

      expect(firstAcs.headers.get('location')).toBe(callbackURL)
      expect(setsSession(firstAcs)).toBe(true)
      expect(secondAcs.headers.get('location')).toBe(callbackURL)
      expect(setsSession(secondAcs)).toBe(true)
    })

    it('refuses a response replayed in the browser that already used it', async () => {
      const login = await startLogin(`replay-${crypto.randomUUID()}@example.com`)
      expect(setsSession(await postToAcs(login, login))).toBe(true)

      const replay = await postToAcs(login, login)

      expect(replay.headers.get('location')).toContain('error=')
      expect(setsSession(replay)).toBe(false)
    })

    describe('login cookie', () => {
      const useHttps = () =>
        getSettingsSpy.mockReturnValue({ ...baseSettings, samlCert: idpCert, betterAuthUrl: 'https://api.example.com' })
      const loginCookie = (login: Login) =>
        login.setCookies.find((entry) => entry.includes(`thunderbolt_saml_login_${login.relayState}=`))

      it('is a host-only __Host- cookie that reaches the cross-site ACS POST over HTTPS', async () => {
        useHttps()
        const login = await startLogin('cookie@example.com')
        const cookie = loginCookie(login)

        expect(cookie).toStartWith(`__Host-thunderbolt_saml_login_${login.relayState}=`)
        expect(cookie).toContain('Path=/')
        expect(cookie).toContain('Secure')
        expect(cookie).toContain('SameSite=None')
        expect(cookie).toContain('HttpOnly')
        expect(cookie).toContain('Max-Age=300')
        expect(cookie).not.toContain('Domain')
      })

      it('completes an HTTPS login whose browser returns the __Host- cookie', async () => {
        useHttps()
        const login = await startLogin(`https-${crypto.randomUUID()}@example.com`)

        expect(setsSession(await postToAcs(login, login))).toBe(true)
      })

      it('refuses over HTTPS the unprefixed names a sibling subdomain could plant', async () => {
        useHttps()
        const attacker = await attackerLogin()
        const planted = [
          `thunderbolt_saml_login_${attacker.relayState}=1`,
          `__Secure-thunderbolt_saml_login_${attacker.relayState}=1`,
          `__Secure-better-auth.thunderbolt_saml_login_${attacker.relayState}=1`,
        ].join('; ')

        const acs = await postToAcs(attacker, { cookie: planted, relayState: attacker.relayState })

        expect(acs.headers.get('location')).toContain('error=unsolicited_response')
        expect(setsSession(acs)).toBe(false)
      })

      it('is a host-only Lax cookie over plain HTTP, where browsers drop SameSite=None', async () => {
        const login = await startLogin('cookie@example.com')
        const cookie = loginCookie(login)

        expect(cookie).toStartWith(`thunderbolt_saml_login_${login.relayState}=`)
        expect(cookie).toContain('SameSite=Lax')
        expect(cookie).toContain('Max-Age=300')
        expect(cookie).not.toContain('Domain')
      })

      it("leaves Better Auth's own relay_state cookie at its defaults", async () => {
        const login = await startLogin('cookie@example.com')

        expect(login.setCookies.find((entry) => entry.startsWith('better-auth.relay_state='))).toContain('Max-Age=300')
      })
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

    it('serves SP metadata only for the configured provider', async () => {
      const { createAuth } = await import('./auth')
      const app = new Elysia({ prefix: '/v1' }).mount(createAuth(db).handler)
      const metadataFor = (providerId: string) =>
        app.handle(new Request(`http://localhost/v1/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`))

      expect((await metadataFor('stored-idp')).status).toBe(403)
      expect((await metadataFor('sso')).status).toBe(200)
    })
  })
})
