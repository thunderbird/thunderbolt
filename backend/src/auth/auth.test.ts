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
import { createAuth } from '@/auth/auth'
import { verifySignedBearerToken } from '@/auth/bearer-token'
import { normalizeEmail } from '@/lib/email'
import { createTestDb } from '@/test-utils/db'
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

    const result = (await auth.api.signInEmailOTP({
      body: { email: 'newuser@example.com', otp },
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

    const result = (await auth.api.signInEmailOTP({
      body: { email: 'existing-isnewuser@example.com', otp },
    })) as unknown as { session: unknown; user: { isNew?: boolean } }

    expect(result.user?.isNew).toBe(false)
    expect(result.session).toBeDefined()
    expect(result.user).toBeDefined()
  })
})

describe('Auth - signed bearer token in login response', () => {
  const betterAuthSecret = process.env.BETTER_AUTH_SECRET!

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

  const signInAndGetToken = async (email: string) => {
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })

    const callArgs = (mockSendSignInEmail.mock.calls as unknown as Array<[{ otp: string }]>).at(-1)?.[0]
    const otp = callArgs!.otp

    return (await auth.api.signInEmailOTP({ body: { email, otp } })) as unknown as {
      session: { token: string }
      user: { id: string }
    }
  }

  it('should return a signed session token for new user sign-in', async () => {
    await db.insert(waitlist).values({
      id: crypto.randomUUID(),
      email: 'signed-new@example.com',
      status: 'approved',
    })

    const result = await signInAndGetToken('signed-new@example.com')

    expect(result.session.token).toBeDefined()
    // Token must contain a dot (rawToken.signature format)
    expect(result.session.token).toContain('.')
    // Token must be verifiable with the correct secret
    const rawToken = verifySignedBearerToken(result.session.token, betterAuthSecret)
    expect(rawToken).not.toBeNull()
  })

  it('should return a signed session token for existing user sign-in', async () => {
    await db.insert(user).values({
      id: crypto.randomUUID(),
      name: 'Existing Signed',
      email: 'signed-existing@example.com',
      emailVerified: true,
      isNew: false,
    })

    const result = await signInAndGetToken('signed-existing@example.com')

    expect(result.session.token).toBeDefined()
    const rawToken = verifySignedBearerToken(result.session.token, betterAuthSecret)
    expect(rawToken).not.toBeNull()
  })

  it('signed token should not verify with wrong secret', async () => {
    await db.insert(user).values({
      id: crypto.randomUUID(),
      name: 'Wrong Secret User',
      email: 'signed-wrong-secret@example.com',
      emailVerified: true,
      isNew: false,
    })

    const result = await signInAndGetToken('signed-wrong-secret@example.com')

    expect(verifySignedBearerToken(result.session.token, 'completely-wrong-secret-value!!')).toBeNull()
  })

  it('raw token extracted from signed token should be a valid session identifier', async () => {
    await db.insert(user).values({
      id: crypto.randomUUID(),
      name: 'Session Check User',
      email: 'signed-session-check@example.com',
      emailVerified: true,
      isNew: false,
    })

    const result = await signInAndGetToken('signed-session-check@example.com')
    const rawToken = verifySignedBearerToken(result.session.token, betterAuthSecret)
    expect(rawToken).not.toBeNull()
    // Raw token should be non-empty and not contain the signature
    expect(rawToken!.length).toBeGreaterThan(0)
    expect(rawToken!).not.toContain(result.session.token.substring(result.session.token.lastIndexOf('.') + 1))
  })

  it('different sign-ins should produce different signed tokens', async () => {
    await db.insert(user).values({
      id: crypto.randomUUID(),
      name: 'Multi Sign User',
      email: 'signed-multi@example.com',
      emailVerified: true,
      isNew: false,
    })

    const result1 = await signInAndGetToken('signed-multi@example.com')
    mockSendSignInEmail.mockClear()
    const result2 = await signInAndGetToken('signed-multi@example.com')

    // Each sign-in creates a new session with a different token
    expect(result1.session.token).not.toBe(result2.session.token)
    // Both should still be verifiable
    expect(verifySignedBearerToken(result1.session.token, betterAuthSecret)).not.toBeNull()
    expect(verifySignedBearerToken(result2.session.token, betterAuthSecret)).not.toBeNull()
  })
})
