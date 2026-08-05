/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Integration tests for the anonymous() Better Auth plugin wiring (THU-383).
 *
 * Verifies:
 * - The minimal onLinkAccount deletes the anonymous user row on promotion.
 * - The session-fixation guard rejects /sign-in/anonymous from a real session.
 */

import { user as userTable } from '@/db/auth-schema'
import { waitlist } from '@/db/schema'
import { challengeTokenHeader } from '@/auth/otp-constants'
import { createAuth, type AuthEmailDeps } from '@/auth/auth'
import { clearSettingsCache } from '@/config/settings'
import { createApp } from '@/index'
import { createTestDb } from '@/test-utils/db'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'

const mockSendSignInEmail = mock(() => Promise.resolve())

/**
 * Build the email-dep overrides for `createAuth` so tests don't actually hit
 * the email service. Injected via the producer arg instead of module-level
 * mocking — keeps overrides scoped to this file and prevents cross-file leakage
 * in the same Bun worker.
 */
const buildEmailDeps = (): AuthEmailDeps => ({
  sendSignInEmail: mockSendSignInEmail,
  sendWaitlistJoinedEmail: mock(() => Promise.resolve()),
  sendWaitlistNotReadyEmail: mock(() => Promise.resolve()),
})

// All suites here exercise the anonymous() plugin, which is operator-gated by
// AUTH_ALLOW_ANONYMOUS. Enable it for the file and restore on teardown.
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

// ---------------------------------------------------------------------------
// Suite: onLinkAccount deletes the anonymous user row
// ---------------------------------------------------------------------------

describe('anonymous plugin — link deletes anonymous user', () => {
  let auth: ReturnType<typeof createAuth>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

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

  it('deletes the anonymous user row after email-otp promotion', async () => {
    // 1. Create an anonymous session; capture its cookie so Better Auth treats the next
    //    sign-in as a link/promotion (firing onLinkAccount).
    const anonResponse = (await auth.api.signInAnonymous({ asResponse: true })) as Response
    expect(anonResponse.status).toBe(200)
    const anonBody = (await anonResponse.json()) as { user: { id: string } }
    const anonId = anonBody.user.id
    const anonCookie = anonResponse.headers.get('set-cookie')
    expect(anonCookie).toBeTruthy()

    // 2. Seed an approved waitlist row + a valid challenge token for the OTP path.
    const realEmail = `promote-delete-${crypto.randomUUID()}@example.com`
    await db.insert(waitlist).values({ id: crypto.randomUUID(), email: realEmail, status: 'approved' })

    await auth.api.sendVerificationOTP({ body: { email: realEmail, type: 'sign-in' } })
    const otp = (mockSendSignInEmail.mock.calls as unknown as Array<[{ otp: string }]>)[0]?.[0]?.otp
    expect(otp).toBeDefined()

    const challengeToken = await createTestChallenge(db, realEmail)

    // 3. Sign in with the anonymous session cookie attached — Better Auth detects the
    //    anonymous session and runs onLinkAccount, which deletes the anonymous user row.
    await auth.api.signInEmailOTP({
      body: { email: realEmail, otp: otp! },
      headers: new Headers({
        [challengeTokenHeader]: challengeToken,
        Cookie: anonCookie!,
      }),
    })

    const anonRows = await db.select().from(userTable).where(eq(userTable.id, anonId))
    expect(anonRows).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Suite: Session-fixation guard
// ---------------------------------------------------------------------------

describe('anonymous plugin — session-fixation guard', () => {
  let auth: ReturnType<typeof createAuth>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

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

  it('allows /sign-in/anonymous when no session exists', async () => {
    const result = (await auth.api.signInAnonymous({
      asResponse: true,
    })) as Response

    expect(result.status).toBe(200)
    const body = (await result.json()) as { user?: { isAnonymous?: boolean }; token?: string }
    expect(body.user?.isAnonymous).toBe(true)
    expect(body.token).toBeDefined()
  })

  it('allows an anonymous session to access protected routes', async () => {
    const app = await createApp({ database: db, auth })
    const signInResponse = (await auth.api.signInAnonymous({ asResponse: true })) as Response
    const sessionCookie = signInResponse.headers.get('set-cookie')
    expect(sessionCookie).toBeTruthy()

    const response = await app.handle(
      new Request('http://localhost/v1/devices/allowlist', { headers: { Cookie: sessionCookie! } }),
    )

    expect(response.status).toBe(200)
  })

  it('rejects /sign-in/anonymous with 400 when caller is already authenticated (non-anonymous)', async () => {
    const realEmail = `fixation-guard@example.com`
    await db.insert(waitlist).values({ id: crypto.randomUUID(), email: realEmail, status: 'approved' })

    await auth.api.sendVerificationOTP({ body: { email: realEmail, type: 'sign-in' } })
    const otp = (mockSendSignInEmail.mock.calls as unknown as Array<[{ otp: string }]>)[0]?.[0]?.otp
    expect(otp).toBeDefined()

    const challengeToken = await createTestChallenge(db, realEmail)

    // Sign in via asResponse to capture the session cookie
    const signInResponse = (await auth.api.signInEmailOTP({
      body: { email: realEmail, otp: otp! },
      headers: new Headers({ [challengeTokenHeader]: challengeToken }),
      asResponse: true,
    })) as Response

    expect(signInResponse.status).toBe(200)

    // Extract session cookie from the response
    const setCookieHeader = signInResponse.headers.get('set-cookie')
    expect(setCookieHeader).toBeTruthy()

    // Attempt to acquire an anonymous session while holding a real session (via cookie).
    // Better Auth throws APIError directly when called via auth.api (not HTTP); catch it.
    let thrownError: unknown
    try {
      await auth.api.signInAnonymous({
        headers: new Headers({ Cookie: setCookieHeader! }),
      })
    } catch (err) {
      thrownError = err
    }

    expect(thrownError).toBeDefined()
    const errMessage = thrownError instanceof Error ? thrownError.message : String(thrownError)
    expect(errMessage).toContain('Already authenticated')
  })

  it('allows a second /sign-in/anonymous from an already-anonymous session (before-hook permits)', async () => {
    // First sign-in: creates an anon session
    const first = (await auth.api.signInAnonymous({ asResponse: true })) as Response
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { token: string; user: { isAnonymous: boolean } }
    expect(firstBody.user.isAnonymous).toBe(true)
    const anonToken = firstBody.token

    // Our before-hook allows anonymous users to hit /sign-in/anonymous (returns early).
    // The plugin's own endpoint then checks its own guard and may return 400.
    // We only assert our before-hook doesn't block this path (no "Already authenticated" error).
    const second = (await auth.api.signInAnonymous({
      headers: new Headers({ Authorization: `Bearer ${anonToken}` }),
      asResponse: true,
    })) as Response

    // Our hook must NOT have returned "Already authenticated" (400 with that specific message)
    if (second.status === 400) {
      const body = (await second.clone().json()) as { message?: string }
      expect(body.message).not.toBe('Already authenticated')
    }
  })
})

// ---------------------------------------------------------------------------
// Suite: AUTH_ALLOW_ANONYMOUS=false unregisters the plugin (defense-in-depth)
// ---------------------------------------------------------------------------

describe('anonymous plugin — gated by AUTH_ALLOW_ANONYMOUS', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  it('does NOT expose /sign-in/anonymous when AUTH_ALLOW_ANONYMOUS is unset (default false)', async () => {
    const previous = process.env.AUTH_ALLOW_ANONYMOUS
    delete process.env.AUTH_ALLOW_ANONYMOUS
    clearSettingsCache()
    try {
      const gatedAuth = createAuth(db, buildEmailDeps())
      // The plugin is the only thing that adds `signInAnonymous` to `auth.api`; without it,
      // the method is undefined.
      expect((gatedAuth.api as unknown as { signInAnonymous?: unknown }).signInAnonymous).toBeUndefined()
    } finally {
      if (previous === undefined) {
        delete process.env.AUTH_ALLOW_ANONYMOUS
      } else {
        process.env.AUTH_ALLOW_ANONYMOUS = previous
      }
      clearSettingsCache()
    }
  })
})
