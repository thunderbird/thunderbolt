/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { challengeTokenHeader, testSignInOtp } from '@/auth/otp-constants'
import { auditEvent, membershipSource, orgMembership, session as sessionTable, user, waitlist } from '@/db/schema'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { authorizeWsBearer, wsCloseUnauthorized } from '@/auth/ws-bearer-auth'
import { encodeWsBearer, wsBearerSubprotocolPrefix } from '@shared/ws-bearer'
import { passkey } from '@better-auth/passkey'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import type { AccessState } from './access'
import { decideSignIn, passkeySignInPath } from './plugin'
import { otpSignInPath } from './sign-in'

const authBase = 'http://localhost/v1/api/auth'

describe('identity plugin', () => {
  let harness: TestAppHandle
  let userId: string

  beforeEach(async () => {
    harness = await createTestApp()
    const [row] = await harness.db.select({ id: user.id }).from(user).where(eq(user.email, harness.email))
    userId = row.id
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  const block = () =>
    harness.db.update(orgMembership).set({ blockedAt: new Date() }).where(eq(orgMembership.userId, userId))

  const getSession = async (headers: Record<string, string>) => {
    const res = await harness.app.handle(new Request(`${authBase}/get-session`, { headers }))
    return { status: res.status, body: await res.json() }
  }

  /** A route behind the `auth: true` macro. */
  const getProtected = (headers: Record<string, string>) =>
    harness.app.handle(new Request('http://localhost/v1/encryption/canary', { headers }))

  const createApiKey = async () => {
    const res = await harness.app.handle(
      new Request(`${authBase}/api-key/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(harness.bearerToken) },
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as { key: string }).key
  }

  /** Sign the harness user in again by email code, through a fresh auth instance on the same database. */
  const signInAgain = async () => {
    const auth = createAuth(harness.db)
    await auth.api.sendVerificationOTP({ body: { email: harness.email, type: 'sign-in' } })
    return (await auth.api.signInEmailOTP({
      body: { email: harness.email, otp: testSignInOtp },
      headers: new Headers({
        [challengeTokenHeader]: await createTestChallenge(harness.db, harness.email),
        'user-agent': 'identity-test',
      }),
      asResponse: true,
    })) as Response
  }

  it('admits a waitlist-approved address at its first email-code sign-in', async () => {
    const [approval] = await harness.db
      .select({ id: waitlist.id })
      .from(waitlist)
      .where(eq(waitlist.email, harness.email))
    const sources = await harness.db
      .select({ kind: membershipSource.kind, ref: membershipSource.ref, status: membershipSource.status })
      .from(membershipSource)
      .innerJoin(orgMembership, eq(orgMembership.id, membershipSource.membershipId))
      .where(eq(orgMembership.userId, userId))
    expect(sources).toEqual([{ kind: 'waitlist', ref: approval.id, status: 'active' }])

    const admitted = await harness.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'member.admitted'), eq(auditEvent.targetId, userId)))
    expect(admitted).toHaveLength(1)
    expect((await getSession(authHeaders(harness.bearerToken))).body?.user?.id).toBe(userId)
  })

  it('treats a blocked member as signed out on every request, by bearer and by cookie', async () => {
    expect((await getProtected(authHeaders(harness.bearerToken))).status).not.toBe(401)
    await block()

    expect((await getSession(authHeaders(harness.bearerToken))).body).toBeNull()
    const cookie = { cookie: `better-auth.session_token=${encodeURIComponent(harness.bearerToken)}` }
    expect((await getSession(cookie)).body).toBeNull()
    expect((await getProtected(authHeaders(harness.bearerToken))).status).toBe(401)
  })

  it('refuses the WebSocket upgrade of a blocked member', async () => {
    const auth = createAuth(harness.db)
    const subprotocols = `thunderbolt.v1, ${wsBearerSubprotocolPrefix}${encodeWsBearer(harness.bearerToken)}`
    expect(await authorizeWsBearer(auth, subprotocols)).toMatchObject({ ok: true })

    await block()

    expect(await authorizeWsBearer(auth, subprotocols)).toEqual({
      ok: false,
      closeCode: wsCloseUnauthorized,
      closeReason: 'unauthorized',
    })
  })

  it('refuses the API key of a blocked member on the short-circuited get-session path and on routes', async () => {
    const key = await createApiKey()
    expect((await getSession({ 'x-api-key': key })).body?.user?.id).toBe(userId)
    expect((await getProtected({ 'x-api-key': key })).status).not.toBe(401)

    await block()

    expect((await getSession({ 'x-api-key': key })).status).toBe(403)
    expect((await getProtected({ 'x-api-key': key })).status).toBe(401)
  })

  it('leaves an unknown API key to the api-key plugin', async () => {
    const res = await getSession({ 'x-api-key': `${'x'.repeat(64)}` })
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ code: 'INVALID_API_KEY' })
  })

  it('refuses a blocked member at sign-in, creates no session, and records the failed attempt', async () => {
    await block()
    const sessionsBefore = await harness.db.$count(sessionTable, eq(sessionTable.userId, userId))

    const res = await signInAgain()

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'ACCESS_BLOCKED' })
    expect(await harness.db.$count(sessionTable, eq(sessionTable.userId, userId))).toBe(sessionsBefore)
    const [failure] = await harness.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'auth.sign_in'), eq(auditEvent.actorId, userId)))
    expect(failure).toMatchObject({
      outcome: 'failure',
      reason: 'ACCESS_BLOCKED',
      targetId: userId,
      userAgent: 'identity-test',
    })
  })

  it('admits an existing user with no membership again when a rule still matches', async () => {
    await harness.db.delete(orgMembership).where(eq(orgMembership.userId, userId))

    expect((await signInAgain()).status).toBe(200)
    expect(await harness.db.$count(orgMembership, eq(orgMembership.userId, userId))).toBe(1)
  })

  it('refuses an existing user that no rule admits', async () => {
    await harness.db.delete(orgMembership).where(eq(orgMembership.userId, userId))
    await harness.db.delete(waitlist).where(eq(waitlist.email, harness.email))

    const res = await signInAgain()

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'ACCESS_NOT_MEMBER' })
  })
})

describe('SSO-only sign-in', () => {
  const managed: AccessState = {
    membership: { id: 'm1', orgId: 'default', userId: 'u1', blockedAt: null },
    sources: [{ id: 's1', kind: 'scim', status: 'active', identityConnectionId: 'entra', ref: null }],
    connectionStatusById: new Map([['entra', 'active']]),
    ssoConnectionIds: new Set(['entra']),
  }

  it('names the path the passkey plugin signs in on', () => {
    const plugin = passkey({ rpID: 'localhost', rpName: 'Thunderbolt', origin: 'http://localhost' })
    expect(plugin.endpoints.verifyPasskeyAuthentication.path).toBe(passkeySignInPath)
  })

  it('refuses passkey and email-code sign-in to an IdP-managed member, and lets SSO through', () => {
    expect(decideSignIn(managed, passkeySignInPath)).toEqual({ allowed: false, reason: 'sso_required' })
    expect(decideSignIn(managed, otpSignInPath)).toEqual({ allowed: false, reason: 'sso_required' })
    expect(decideSignIn(managed, '/sso/callback/:providerId')).toEqual({ allowed: true })
    expect(decideSignIn({ ...managed, ssoConnectionIds: new Set() }, passkeySignInPath)).toEqual({ allowed: true })
  })
})
