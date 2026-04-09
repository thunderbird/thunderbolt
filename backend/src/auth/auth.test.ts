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

describe('Auth - session token redaction', () => {
  let auth: ReturnType<typeof createAuth>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let sessionToken: string

  beforeEach(async () => {
    mockSendSignInEmail.mockClear()

    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    auth = createAuth(db)

    // Create approved waitlist entry + sign in to get a session
    await db.insert(waitlist).values({ id: crypto.randomUUID(), email: 'redact@example.com', status: 'approved' })
    await auth.api.sendVerificationOTP({ body: { email: 'redact@example.com', type: 'sign-in' } })
    const otp = (mockSendSignInEmail.mock.calls as unknown as Array<[{ otp: string }]>).at(0)![0].otp
    const signIn = (await auth.api.signInEmailOTP({ body: { email: 'redact@example.com', otp } })) as unknown as {
      session: { token: string }
    }
    sessionToken = signIn.session.token
  })

  afterEach(async () => {
    await cleanup()
  })

  it('should strip token from get-session response', async () => {
    const result = (await auth.api.getSession({
      headers: new Headers({ Authorization: `Bearer ${sessionToken}` }),
    })) as unknown as { session: Record<string, unknown>; user: Record<string, unknown> } | null

    expect(result).not.toBeNull()
    expect(result!.session.id).toBeDefined()
    expect(result!.session.token).toBeUndefined()
    expect(result!.user.email).toBe('redact@example.com')
  })

  it('should strip token from list-sessions response', async () => {
    const result = (await auth.api.listSessions({
      headers: new Headers({ Authorization: `Bearer ${sessionToken}` }),
    })) as unknown as Record<string, unknown>[]

    expect(result.length).toBeGreaterThan(0)
    for (const session of result) {
      expect(session.token).toBeUndefined()
      expect(session.id).toBeDefined()
    }
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
