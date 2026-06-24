/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Security regression test (CWE-1004): the Better Auth session cookie MUST be
 * issued with the `HttpOnly` attribute so client-side JS (`document.cookie`)
 * cannot read the session token. This locks in Better Auth's secure default and
 * guards against a future config change (e.g. `advanced.defaultCookieAttributes`
 * or `advanced.cookies`) silently disabling `HttpOnly`.
 *
 * Covers every cookie the backend mints on a real sign-in: the email-OTP
 * session cookie and the anonymous session cookie. The SSO desktop nonce cookie
 * (also HttpOnly) is asserted in sso-desktop-callback.test.ts.
 */

import { waitlist } from '@/db/schema'
import { challengeTokenHeader } from '@/auth/otp-constants'
import { createAuth, type AuthEmailDeps } from '@/auth/auth'
import { clearSettingsCache } from '@/config/settings'
import { createTestDb } from '@/test-utils/db'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'

const mockSendSignInEmail = mock(() => Promise.resolve())

const buildEmailDeps = (): AuthEmailDeps => ({
  sendSignInEmail: mockSendSignInEmail,
  sendWaitlistJoinedEmail: mock(() => Promise.resolve()),
  sendWaitlistNotReadyEmail: mock(() => Promise.resolve()),
})

/** Cookie name + lower-cased attribute flags for one Set-Cookie header line. */
const parseSetCookie = (raw: string) => {
  const [nameValue, ...attrParts] = raw.split(';').map((p) => p.trim())
  const name = nameValue.split('=')[0]
  const flags = new Set(attrParts.map((p) => p.split('=')[0].toLowerCase()))
  return { name, flags }
}

/** Find the session-token cookie among all Set-Cookie lines (tolerates the `__Secure-` prefix). */
const findSessionCookie = (cookies: ReturnType<typeof parseSetCookie>[]) =>
  cookies.find((c) => c.name.endsWith('session_token'))

/** Assert the response carries an HttpOnly session cookie; returns all parsed cookies + the session one. */
const expectHttpOnlySessionCookie = (res: Response) => {
  const all = res.headers.getSetCookie().map(parseSetCookie)
  const session = findSessionCookie(all)
  expect(session).toBeDefined()
  expect(session!.flags.has('httponly')).toBe(true)
  return { all, session: session! }
}

describe('session cookie HttpOnly (CWE-1004 regression)', () => {
  let auth: ReturnType<typeof createAuth>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  // The anonymous case needs the operator-gated anonymous() plugin.
  let savedAllowAnonymous: string | undefined
  beforeAll(() => {
    savedAllowAnonymous = process.env.AUTH_ALLOW_ANONYMOUS
    process.env.AUTH_ALLOW_ANONYMOUS = 'true'
    clearSettingsCache()
  })
  afterAll(() => {
    if (savedAllowAnonymous === undefined) {
      delete process.env.AUTH_ALLOW_ANONYMOUS
    } else {
      process.env.AUTH_ALLOW_ANONYMOUS = savedAllowAnonymous
    }
    clearSettingsCache()
  })

  beforeEach(async () => {
    mockSendSignInEmail.mockClear()
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    auth = createAuth(db, buildEmailDeps())
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  it('email-OTP sign-in issues an HttpOnly, SameSite session cookie (and no JS-readable __session cookie)', async () => {
    const email = `httponly-otp-${crypto.randomUUID()}@example.com`
    await db.insert(waitlist).values({ id: crypto.randomUUID(), email, status: 'approved' })

    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    const otp = (mockSendSignInEmail.mock.calls as unknown as Array<[{ otp: string }]>)[0]?.[0]?.otp
    expect(otp).toBeDefined()

    const challengeToken = await createTestChallenge(db, email)

    const res = (await auth.api.signInEmailOTP({
      body: { email, otp: otp! },
      headers: new Headers({ [challengeTokenHeader]: challengeToken }),
      asResponse: true,
    })) as Response

    expect(res.status).toBe(200)

    const { all, session } = expectHttpOnlySessionCookie(res)
    expect(session.flags.has('samesite')).toBe(true)

    // The advisory's claimed cookie name does not (and must not) exist here.
    expect(all.find((c) => c.name === '__session')).toBeUndefined()
  })

  it('anonymous sign-in issues an HttpOnly session cookie', async () => {
    const res = (await auth.api.signInAnonymous({ asResponse: true })) as Response
    expect(res.status).toBe(200)

    expectHttpOnlySessionCookie(res)
  })
})
