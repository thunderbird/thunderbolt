/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createAuth } from '@/auth/auth'
import { challengeTokenHeader, testSignInOtp } from '@/auth/otp-constants'
import * as settingsModule from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { devicesTable, session as sessionTable, user } from '@/db/schema'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import { createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { createFakeOidcIdps, type FakeOidcIdps, fakeOidcClientId } from '@/test-utils/fake-oidc'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { createScimClient, keycloakUser, type ScimClient, uniqueSuffix } from '@/test-utils/scim'
import { createTestSettings } from '@/test-utils/settings'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createScimConnection } from './scim/connections'
import { createSsoConnection } from './sso-connections'

/*
 * The IdP goes down. Access is decided from Thunderbolt's own records, so everything a signed-in
 * member does keeps working without one request to the IdP; only a new SSO sign-in needs it, and
 * fails visibly. Failed provisioning is visible to an admin.
 */
describe('an identity provider outage', () => {
  let db: typeof DbType
  let auth: Auth
  let harness: TestAppHandle
  let idps: FakeOidcIdps
  let scim: ScimClient
  let settingsSpy: ReturnType<typeof spyOn>
  let connectionId: string
  let member: { email: string; externalId: string; scimId: string; userId: string; cookie: string; apiKey: string }

  const suffix = uniqueSuffix()
  const issuer = `https://outage-${suffix}.idp.test`
  const providerId = `outage-${suffix}`
  const breakGlassEmail = `break-glass-${suffix}@example.com`
  const deviceId = crypto.randomUUID()

  const request = (path: string, init: RequestInit = {}) =>
    harness.app.handle(new Request(`http://localhost/v1${path}`, init))

  /** Sign in by email code and return the session's signed bearer token. */
  const signInByCode = async (email: string) => {
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    const response = (await auth.api.signInEmailOTP({
      body: { email, otp: testSignInOtp },
      headers: new Headers({ [challengeTokenHeader]: await createTestChallenge(db, email) }),
      asResponse: true,
    })) as Response
    return { status: response.status, bearer: response.headers.get('set-auth-token') }
  }

  beforeAll(async () => {
    ;({ db } = await getSharedIsolatedTestDb())
    settingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(
      createTestSettings({
        logLevel: 'ERROR',
        posthogHost: '',
        authMode: 'oidc',
        oidcIssuer: 'https://env.idp.test',
        oidcClientId: fakeOidcClientId,
        oidcClientSecret: 'env-secret',
        bootstrapAdminEmails: breakGlassEmail,
        powersyncUrl: 'http://localhost:8080',
        powersyncJwtSecret: 'outage-test-powersync-secret-of-32-chars',
        powersyncJwtKid: 'outage-test',
        betterAuthSecret: process.env.BETTER_AUTH_SECRET,
      }),
    )
    idps = await createFakeOidcIdps([issuer])
    await idps.withIdps(async () => {
      auth = createAuth(db)
      harness = await createTestApp({ database: db })
    })
    const actorId = `outage-admin-${suffix}`
    await db.insert(user).values({ id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
    connectionId = await createSsoConnection(db, {
      name: `Outage ${suffix}`,
      providerId,
      protocol: { oidc: { issuer, clientId: fakeOidcClientId, clientSecret: 'outage-secret' } },
    })
    const { token } = await createScimConnection(auth, { actorId, identityConnectionId: connectionId })
    scim = createScimClient((scimRequest) => harness.app.handle(scimRequest), token)

    const email = `member-${suffix}@example.com`
    const externalId = crypto.randomUUID()
    const created = await scim.call('POST', '/Users', { body: keycloakUser(email, email, externalId) })
    expect(created.status).toBe(201)
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
    const signedIn = await idps.signIn(harness.app, { providerId, issuer, subject: externalId, email })
    expect(signedIn.cookie).not.toBe('')
    // Bind the SSO session to a device, as the app does before it syncs.
    await db.insert(devicesTable).values({ id: deviceId, userId: row.id, trusted: true, nodeId: `node-${deviceId}` })
    await db.update(sessionTable).set({ deviceId }).where(eq(sessionTable.userId, row.id))
    const { key } = await auth.api.createApiKey({ body: { userId: row.id } })
    member = { email, externalId, scimId: created.body.id!, userId: row.id, cookie: signedIn.cookie, apiKey: key }
  })

  afterAll(() => {
    settingsSpy.mockRestore()
  })

  it('keeps sessions, API keys, sync tokens and provisioning working with no request to the IdP', async () => {
    idps.setReachable(false)
    idps.requests.length = 0
    try {
      // While the IdP's stand-in is the process's fetch, any outbound request fails the test.
      const [viaCookie, viaKey, syncToken, update] = await idps.withIdps(() =>
        Promise.all([
          request('/api/auth/get-session', { headers: { Cookie: member.cookie } }),
          request('/api/auth/get-session', { headers: { 'x-api-key': member.apiKey } }),
          request('/powersync/token', { headers: { Cookie: member.cookie, 'x-device-id': deviceId } }),
          scim.patch(`/Users/${member.scimId}`, [{ op: 'replace', path: 'name.givenName', value: 'Renamed' }]),
        ]),
      )

      expect(((await viaCookie.json()) as { user: { id: string } }).user.id).toBe(member.userId)
      expect(((await viaKey.json()) as { user: { id: string } }).user.id).toBe(member.userId)
      expect(syncToken.status).toBe(200)
      expect(update.status).toBe(200)
      expect(idps.requests).toEqual([])
    } finally {
      idps.setReachable(true)
    }
  })

  it('fails a new SSO sign-in visibly while the IdP is down, and lets the break-glass admin in by email code', async () => {
    idps.setReachable(false)
    try {
      const attempt = await idps.signIn(harness.app, {
        providerId,
        issuer,
        subject: member.externalId,
        email: member.email,
      })
      const breakGlass = await idps.withIdps(() => signInByCode(breakGlassEmail))

      // The sign-in can't start: the provider's discovery document is unreachable.
      expect(attempt).toEqual({ status: 502, location: null, cookie: '' })
      expect(idps.requests.length).toBeGreaterThan(0)
      expect(breakGlass.status).toBe(200)
    } finally {
      idps.setReachable(true)
    }
  })

  it('shows an admin the provisioning requests it refused, and when each credential was last used', async () => {
    const changeExternalId = await scim.patch(`/Users/${member.scimId}`, [
      { op: 'replace', path: 'externalId', value: crypto.randomUUID() },
    ])
    expect(changeExternalId.status).toBeGreaterThanOrEqual(400)
    const { bearer } = await signInByCode(breakGlassEmail)
    const admin = { Authorization: `Bearer ${bearer}` }

    const failures = await request(
      `/admin/audit-events?connectionId=${connectionId}&action=scim.request&outcome=failure`,
      { headers: admin },
    )
    const connection = await request(`/admin/connections/${connectionId}`, { headers: admin })

    expect(failures.status).toBe(200)
    expect(((await failures.json()) as { events: unknown[] }).events).toEqual([
      expect.objectContaining({ action: 'scim.request', outcome: 'failure', connectionId }),
    ])
    const { scimCredentials } = (await connection.json()) as { scimCredentials: { lastUsedAt: string | null }[] }
    expect(scimCredentials).toHaveLength(1)
    expect(scimCredentials[0].lastUsedAt).not.toBeNull()
  })
})
