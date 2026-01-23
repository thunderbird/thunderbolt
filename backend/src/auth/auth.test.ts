import { user } from '@/db/auth-schema'
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
