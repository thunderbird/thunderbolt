/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { challengeTokenHeader } from '@/auth/otp-constants'
import { auditEvent, user } from '@/db/schema'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { createScimClient, entraUser, uniqueSuffix } from '@/test-utils/scim'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { SendInvitationEmailParams } from '../invitations/email'
import { createInvitation } from '../invitations/invitations'
import { createScimConnection, retireScimConnection, rotateScimCredential } from '../scim/connections'

/**
 * Runs every audited flow that handles a secret, with the secret known, and checks that no audit
 * row holds it: events keep ids, never the code, token or key itself.
 */
describe('audit events hold no secrets', () => {
  let harness: TestAppHandle

  beforeEach(async () => {
    harness = await createTestApp()
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  const auth = (path: string, init: RequestInit = {}) =>
    harness.app.handle(new Request(`http://localhost/v1/api/auth${path}`, init))

  it('keeps no code, session token, API key, invitation token or SCIM token', async () => {
    const secrets: string[] = []
    const [{ id: userId }] = await harness.db.select({ id: user.id }).from(user).where(eq(user.email, harness.email))

    // An email-code sign-in, a wrong code, then a sign-out.
    const sendSignInEmail = mock((_: { otp: string }) => Promise.resolve())
    await createAuth(harness.db, { sendSignInEmail }).api.sendVerificationOTP({
      body: { email: harness.email, type: 'sign-in' },
    })
    const otp = sendSignInEmail.mock.calls[0][0].otp
    const signIn = (code: string) =>
      createTestChallenge(harness.db, harness.email).then((challenge) =>
        auth('/sign-in/email-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [challengeTokenHeader]: challenge },
          body: JSON.stringify({ email: harness.email, otp: code }),
        }),
      )
    const wrongCode = otp === '999999' ? '999998' : '999999'
    await signIn(wrongCode)
    const signedIn = await signIn(otp)
    const bearer = signedIn.headers.get('set-auth-token')!
    secrets.push(otp, wrongCode, bearer, bearer.split('.')[0], harness.bearerToken, harness.bearerToken.split('.')[0])
    await auth('/sign-out', { method: 'POST', headers: authHeaders(bearer) })

    // An API key refused on an admin route.
    const created = await auth('/api-key/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(harness.bearerToken) },
      body: JSON.stringify({}),
    })
    const { key } = (await created.json()) as { key: string }
    secrets.push(key)
    await harness.app.handle(new Request('http://localhost/v1/admin/audit-events', { headers: { 'x-api-key': key } }))

    // An invitation, whose link carries its token.
    const sent: SendInvitationEmailParams[] = []
    await createInvitation(
      harness.db,
      { email: `invitee-${uniqueSuffix()}@example.com`, invitedBy: userId, locale: 'en' },
      async (params) => {
        sent.push(params)
      },
    )
    secrets.push(sent[0].inviteUrl.split('/invite/')[1])

    // A SCIM connection: create, provision, rotate, retire.
    const betterAuth = createAuth(harness.db)
    const scim = await createScimConnection(betterAuth, { actorId: userId, name: `IdP ${uniqueSuffix()}` })
    const rotated = await rotateScimCredential(betterAuth, {
      identityConnectionId: scim.connection.id,
      actorId: userId,
    })
    secrets.push(scim.token, rotated.token)
    await createScimClient((request) => harness.app.handle(request), scim.token).call('POST', '/Users', {
      body: entraUser(`ada-${uniqueSuffix()}@example.com`, `oid-${uniqueSuffix()}`),
    })
    await retireScimConnection(betterAuth, { identityConnectionId: scim.connection.id, actorId: userId })

    const rows = await harness.db.select().from(auditEvent)
    // Each flow must have written its event, or a write that stopped would pass the scan unseen.
    const recorded = (action: string, outcome: string) =>
      rows.filter((row) => row.action === action && row.outcome === outcome).length
    expect(recorded('auth.sign_in', 'failure')).toBeGreaterThanOrEqual(1)
    expect(recorded('auth.sign_in', 'success')).toBeGreaterThanOrEqual(1)
    expect(recorded('auth.sign_out', 'success')).toBe(1)
    expect(recorded('admin.access_denied', 'denied')).toBe(1)
    expect(recorded('invitation.created', 'success')).toBe(1)
    expect(recorded('scim_credential.rotated', 'success')).toBe(1)
    // Ids and times are generated, so only the fields an event's writer fills are checked.
    const written = rows.map(({ id: _id, occurredAt: _at, requestId: _request, ...row }) => JSON.stringify(row))
    for (const secret of secrets) {
      expect(written.filter((row) => row.includes(secret))).toEqual([])
    }
  })
})
