/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { challengeTokenHeader, testSignInOtp } from '@/auth/otp-constants'
import { auditEvent, session as sessionTable, user } from '@/db/schema'
import { createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { APIError } from 'better-auth'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { signInFailureReason } from './sign-in-audit'

const redirectTo = (location: string) => new APIError('FOUND', undefined, new Headers({ location }))

describe('signInFailureReason', () => {
  it("reads an SSO redirect's error code, and nothing from a redirect without one", () => {
    expect(signInFailureReason('/sso/callback/:providerId', redirectTo('http://app/?error=access_denied'))).toBe(
      'access_denied',
    )
    expect(signInFailureReason('/sso/callback/:providerId', redirectTo('http://app/chats'))).toBeNull()
  })

  it('keeps only code-shaped values', () => {
    expect(signInFailureReason('/sso/callback', redirectTo('http://app/?error=<script>'))).toBe('UNKNOWN')
  })

  it("skips the device grant's polling answers and records its real failures", () => {
    const deviceError = (error: string) => new APIError('BAD_REQUEST', { error })
    expect(signInFailureReason('/device/token', deviceError('authorization_pending'))).toBeNull()
    expect(signInFailureReason('/device/token', deviceError('slow_down'))).toBeNull()
    expect(signInFailureReason('/device/token', deviceError('access_denied'))).toBe('access_denied')
  })

  it("uses an APIError's code, and nothing for a response that is no error", () => {
    expect(signInFailureReason('/sign-in/email-otp', new APIError('BAD_REQUEST', { code: 'INVALID_OTP' }))).toBe(
      'INVALID_OTP',
    )
    expect(signInFailureReason('/sign-in/email-otp', { token: 'x' })).toBeNull()
  })
})

describe('sign-in audit', () => {
  let harness: TestAppHandle

  beforeEach(async () => {
    harness = await createTestApp()
    // Drop the harness's own sign-in, which can share a millisecond with the test's.
    await harness.db.delete(auditEvent)
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  const signInEvents = () => harness.db.select().from(auditEvent).where(eq(auditEvent.action, 'auth.sign_in'))

  const userIdOf = async (email: string) =>
    (await harness.db.select({ id: user.id }).from(user).where(eq(user.email, email)))[0]?.id

  /** An email-code sign-in over HTTP, after a code was sent to `email`. */
  const signIn = async (email: string, { otp = testSignInOtp, challenge = true } = {}) => {
    await createAuth(harness.db).api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    const headers = new Headers({ 'Content-Type': 'application/json', 'user-agent': 'audit-test' })
    if (challenge) {
      headers.set(challengeTokenHeader, await createTestChallenge(harness.db, email))
    }
    return harness.app.handle(
      new Request('http://localhost/v1/api/auth/sign-in/email-otp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, otp }),
      }),
    )
  }

  it('records a successful sign-in with its method, session and client', async () => {
    const res = await signIn(harness.email)
    expect(res.status).toBe(200)

    const userId = await userIdOf(harness.email)
    const [event] = await signInEvents()
    const [session] = await harness.db
      .select({ id: sessionTable.id, token: sessionTable.token })
      .from(sessionTable)
      .where(eq(sessionTable.id, (event.metadata as { sessionId: string }).sessionId))
    expect(event).toMatchObject({
      outcome: 'success',
      actorType: 'user',
      actorId: userId,
      targetId: userId,
      metadata: { method: 'email_code', sessionId: session.id },
      userAgent: 'audit-test',
    })
    expect(event.requestId).toBeString()
    expect(JSON.stringify(event)).not.toContain(session.token)
  })

  it('records a wrong code against the user it names', async () => {
    const res = await signIn(harness.email, { otp: '000000' })
    expect(res.status).not.toBe(200)

    expect(await signInEvents()).toMatchObject([
      { outcome: 'failure', reason: 'INVALID_OTP', actorId: await userIdOf(harness.email) },
    ])
  })

  it('records an unknown address refused before the code is checked, storing nothing that names it', async () => {
    const email = `stranger-${crypto.randomUUID()}@example.com`
    const res = await signIn(email)

    expect(res.status).toBe(401)
    expect(await userIdOf(email)).toBeUndefined()
    const events = await signInEvents()
    expect(events).toMatchObject([
      { outcome: 'failure', reason: 'SIGN_IN_NOT_AVAILABLE', actorId: null, metadata: { method: 'email_code' } },
    ])
    expect(JSON.stringify(events)).not.toContain(email)
  })

  it('records a sign-in with no challenge token', async () => {
    expect((await signIn(harness.email, { challenge: false })).status).toBe(401)

    expect(await signInEvents()).toMatchObject([{ outcome: 'failure', reason: 'CHALLENGE_TOKEN_REQUIRED' }])
  })

  it('records a sign-in with an invalid challenge token against the user it names', async () => {
    await createAuth(harness.db).api.sendVerificationOTP({ body: { email: harness.email, type: 'sign-in' } })
    const res = await harness.app.handle(
      new Request('http://localhost/v1/api/auth/sign-in/email-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [challengeTokenHeader]: 'not-a-challenge' },
        body: JSON.stringify({ email: harness.email, otp: testSignInOtp }),
      }),
    )

    expect(res.status).toBe(401)
    expect(await signInEvents()).toMatchObject([
      { outcome: 'failure', reason: 'CHALLENGE_TOKEN_INVALID', actorId: await userIdOf(harness.email) },
    ])
  })
})
