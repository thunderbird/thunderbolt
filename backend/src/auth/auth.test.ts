/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mock } from 'bun:test'
import * as authUtils from '@/auth/utils'
import * as waitlistUtils from '@/waitlist/utils'

const mockSendSignInEmail = mock(() => Promise.resolve())
const mockSendWaitlistNotReadyEmail = mock(() => Promise.resolve())
const mockSendWaitlistJoinedEmail = mock(() => Promise.resolve())

mock.module('@/auth/utils', () => ({
  ...authUtils,
  sendSignInEmail: mockSendSignInEmail,
}))

mock.module('@/waitlist/utils', () => ({
  ...waitlistUtils,
  sendWaitlistNotReadyEmail: mockSendWaitlistNotReadyEmail,
  sendWaitlistJoinedEmail: mockSendWaitlistJoinedEmail,
  sendWaitlistReminderEmail: mock(() => Promise.resolve()),
}))

import { user } from '@/db/auth-schema'
import { waitlist } from '@/db/schema'
import { challengeTokenHeader } from '@/auth/otp-constants'
import { createAuth } from '@/auth/auth'
import { normalizeEmail } from '@/lib/email'
import { createTestDb } from '@/test-utils/db'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

describe('Auth - Email Normalization', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('databaseHooks.user.create', () => {
    // Create a test-only auth instance with email/password enabled
    // to verify the databaseHooks work correctly.
    // Note: BetterAuth validates email format BEFORE hooks run,
    // so whitespace trimming must happen at the request level (e.g., in sendVerificationOTP)
    const createTestAuth = (database: typeof db) =>
      betterAuth({
        database: drizzleAdapter(database, { provider: 'pg' }),
        emailAndPassword: { enabled: true },
        databaseHooks: {
          user: {
            create: {
              before: async (userData) => ({
                data: { ...userData, email: normalizeEmail(userData.email) },
              }),
            },
          },
        },
      })

    it('should normalize email to lowercase when creating user', async () => {
      const auth = createTestAuth(db)

      await auth.api.signUpEmail({
        body: {
          email: 'TEST@EXAMPLE.COM',
          password: 'testpassword123',
          name: 'Test User',
        },
      })

      const users = await db.select().from(user).where(eq(user.email, 'test@example.com'))
      expect(users).toHaveLength(1)
      expect(users[0].email).toBe('test@example.com')
    })

    it('should normalize mixed case email', async () => {
      const auth = createTestAuth(db)

      await auth.api.signUpEmail({
        body: {
          email: 'John.Doe@Gmail.COM',
          password: 'testpassword123',
          name: 'John Doe',
        },
      })

      const users = await db.select().from(user).where(eq(user.email, 'john.doe@gmail.com'))
      expect(users).toHaveLength(1)
      expect(users[0].email).toBe('john.doe@gmail.com')
    })

    it('should store already lowercase email unchanged', async () => {
      const auth = createTestAuth(db)

      await auth.api.signUpEmail({
        body: {
          email: 'already.lowercase@example.com',
          password: 'testpassword123',
          name: 'Test User',
        },
      })

      const users = await db.select().from(user).where(eq(user.email, 'already.lowercase@example.com'))
      expect(users).toHaveLength(1)
      expect(users[0].email).toBe('already.lowercase@example.com')
    })
  })
})

describe('Auth - user.isNew in sign-in response', () => {
  let auth: ReturnType<typeof createAuth>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    mockSendSignInEmail.mockClear()

    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    auth = createAuth(db)
  })

  afterEach(async () => {
    await cleanup()
  })

  it('should return user.isNew: true when user signs in for the first time', async () => {
    await db.insert(waitlist).values({
      id: crypto.randomUUID(),
      email: 'newuser@example.com',
      status: 'approved',
    })

    await auth.api.sendVerificationOTP({
      body: { email: 'newuser@example.com', type: 'sign-in' },
    })

    expect(mockSendSignInEmail).toHaveBeenCalledTimes(1)
    const callArgs = (mockSendSignInEmail.mock.calls as unknown as Array<[{ otp: string }]>).at(0)?.[0]
    expect(callArgs?.otp).toBeDefined()
    const otp = callArgs!.otp

    const challengeToken = await createTestChallenge(db, 'newuser@example.com')
    const result = (await auth.api.signInEmailOTP({
      body: { email: 'newuser@example.com', otp },
      headers: new Headers({ [challengeTokenHeader]: challengeToken }),
    })) as unknown as { session: unknown; user: { isNew?: boolean } }

    expect(result.user?.isNew).toBe(true)
    expect(result.session).toBeDefined()
    expect(result.user).toBeDefined()
  })

  it('should return user.isNew: false when existing user signs in again', async () => {
    const existingUserId = crypto.randomUUID()

    await db.insert(user).values({
      id: existingUserId,
      name: 'Existing User',
      email: 'existing-isnewuser@example.com',
      emailVerified: true,
      isNew: false,
    })

    await auth.api.sendVerificationOTP({
      body: { email: 'existing-isnewuser@example.com', type: 'sign-in' },
    })

    expect(mockSendSignInEmail).toHaveBeenCalledTimes(1)
    const callArgs = (mockSendSignInEmail.mock.calls as unknown as Array<[{ otp: string }]>).at(0)?.[0]
    expect(callArgs?.otp).toBeDefined()
    const otp = callArgs!.otp

    const challengeToken = await createTestChallenge(db, 'existing-isnewuser@example.com')
    const result = (await auth.api.signInEmailOTP({
      body: { email: 'existing-isnewuser@example.com', otp },
      headers: new Headers({ [challengeTokenHeader]: challengeToken }),
    })) as unknown as { session: unknown; user: { isNew?: boolean } }

    expect(result.user?.isNew).toBe(false)
    expect(result.session).toBeDefined()
    expect(result.user).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// JWT payload PII guard — `definePayload: () => ({})` strips the user record.
//
// Better Auth's `getJwtToken` default spreads `session.user` (email, name,
// image, isNew, …) into the JWT body. Since the JWT travels in the URL
// (`?token=`), JWTs are base64url-encoded and decode trivially in any access
// log. We override `definePayload` so the only claims in the token body are
// the standard JWT ones (`sub`, `aud`, `iss`, `iat`, `exp`).
//
// We can't run the full mint flow here (the Better Auth JWT plugin requires a
// `jwks` schema table that isn't yet present in our drizzle migrations — that
// table is auto-managed by Better Auth in production but would need a separate
// migration to test end-to-end). Instead we validate the configuration
// surface: the plugin's `definePayload` callback returns an empty object for
// every session input. Combined with the upstream behaviour confirmed in
// `node_modules/better-auth/dist/plugins/jwt/sign.mjs:53` (the plugin spreads
// the result and overwrites only `sub`/`iat`), an empty extra payload is
// sufficient to keep PII out of the token body.
// ---------------------------------------------------------------------------

describe('Auth - JWT plugin payload is locked to claims-only (no PII)', () => {
  let auth: ReturnType<typeof createAuth>
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    cleanup = testEnv.cleanup
    auth = createAuth(testEnv.db)
  })

  afterEach(async () => {
    await cleanup()
  })

  type PluginWithJwt = {
    id: string
    options?: { jwt?: { audience?: string; definePayload?: (session: unknown) => Record<string, unknown> } }
  }

  const findJwtPlugin = (): PluginWithJwt => {
    const plugins = (auth.options.plugins ?? []) as PluginWithJwt[]
    const jwtPlugin = plugins.find((p) => p.id === 'jwt')
    if (!jwtPlugin) throw new Error('JWT plugin not registered')
    return jwtPlugin
  }

  it('configures the audience to media-proxy (narrow scope, no replay across endpoints)', () => {
    expect(findJwtPlugin().options?.jwt?.audience).toBe('media-proxy')
  })

  it('definePayload returns an empty object regardless of session input', () => {
    const definePayload = findJwtPlugin().options?.jwt?.definePayload
    expect(typeof definePayload).toBe('function')

    // Realistic session shapes: anything the production code might pass.
    const shapes: unknown[] = [
      {},
      { user: { id: 'u-1', email: 'leaked@example.com', name: 'Should Not Leak', image: 'https://x', isNew: true } },
      {
        session: { id: 's-1' },
        user: {
          id: 'u-2',
          email: 'leaked@example.com',
          name: 'Y',
          image: null,
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          isNew: false,
        },
      },
    ]
    for (const session of shapes) {
      const result = definePayload!(session)
      expect(result).toEqual({})
      // Defense-in-depth: stringifying the result never contains any PII strings.
      expect(JSON.stringify(result)).not.toContain('leaked@example.com')
      expect(JSON.stringify(result)).not.toContain('Should Not Leak')
    }
  })
})
