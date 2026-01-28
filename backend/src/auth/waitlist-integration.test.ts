import { mock } from 'bun:test'
import * as authUtils from '@/auth/utils'
import * as waitlistUtils from '@/waitlist/utils'

// Mock only the email-sending functions, preserve all other exports
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

// Now import the rest
import { user, verification } from '@/db/auth-schema'
import { waitlist } from '@/db/schema'
import { createAuth } from '@/auth/auth'
import { normalizeEmail } from '@/lib/email'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

describe('Auth Waitlist Integration', () => {
  let auth: ReturnType<typeof createAuth>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    mockSendSignInEmail.mockClear()
    mockSendWaitlistNotReadyEmail.mockClear()
    mockSendWaitlistJoinedEmail.mockClear()

    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    auth = createAuth(db)
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('Waitlist gating on sign-in', () => {
    it('should send OTP to approved waitlist user', async () => {
      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email: 'approved@example.com',
        status: 'approved',
      })

      await auth.api.sendVerificationOTP({
        body: { email: 'approved@example.com', type: 'sign-in' },
      })

      expect(mockSendSignInEmail).toHaveBeenCalledTimes(1)
      expect(mockSendWaitlistNotReadyEmail).toHaveBeenCalledTimes(0)
    })

    it('should block pending waitlist user and send not-ready email', async () => {
      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email: 'pending@example.com',
        status: 'pending',
      })

      await expect(
        auth.api.sendVerificationOTP({
          body: { email: 'pending@example.com', type: 'sign-in' },
        }),
      ).rejects.toMatchObject({
        body: { message: 'WAITLIST_NOT_APPROVED' },
      })

      expect(mockSendSignInEmail).toHaveBeenCalledTimes(0)
      expect(mockSendWaitlistNotReadyEmail).toHaveBeenCalledTimes(1)
    })

    it('should add unknown user to waitlist and send joined email', async () => {
      await expect(
        auth.api.sendVerificationOTP({
          body: { email: 'unknown@example.com', type: 'sign-in' },
        }),
      ).rejects.toMatchObject({
        body: { message: 'WAITLIST_NOT_APPROVED' },
      })

      // User added to waitlist and receives joined email
      expect(mockSendSignInEmail).toHaveBeenCalledTimes(0)
      expect(mockSendWaitlistNotReadyEmail).toHaveBeenCalledTimes(0)
      expect(mockSendWaitlistJoinedEmail).toHaveBeenCalledTimes(1)

      // Verify user was added to waitlist
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'unknown@example.com'))
      expect(entries).toHaveLength(1)
      expect(entries[0].status).toBe('pending')
    })

    it('should allow existing user to sign in regardless of waitlist', async () => {
      // Existing users bypass waitlist check
      await db.insert(user).values({
        id: crypto.randomUUID(),
        email: 'existing@example.com',
        name: 'Existing User',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      await auth.api.sendVerificationOTP({
        body: { email: 'existing@example.com', type: 'sign-in' },
      })

      expect(mockSendSignInEmail).toHaveBeenCalledTimes(1)
      expect(mockSendWaitlistNotReadyEmail).toHaveBeenCalledTimes(0)
    })

    it('should normalize email consistently between waitlist and auth', async () => {
      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email: normalizeEmail('USER@EXAMPLE.COM'),
        status: 'approved',
      })

      // Different case should still match due to normalization
      await auth.api.sendVerificationOTP({
        body: { email: 'user@example.com', type: 'sign-in' },
      })

      expect(mockSendSignInEmail).toHaveBeenCalledTimes(1)
    })
  })

  describe('Email normalization edge cases', () => {
    it('should match waitlist entry regardless of input email case', async () => {
      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email: 'mixed-case@example.com',
        status: 'approved',
      })

      // Uppercase input should match lowercase DB entry
      await auth.api.sendVerificationOTP({
        body: { email: 'MIXED-CASE@EXAMPLE.COM', type: 'sign-in' },
      })

      expect(mockSendSignInEmail).toHaveBeenCalledTimes(1)
      expect(mockSendWaitlistNotReadyEmail).toHaveBeenCalledTimes(0)

      // Mixed case also works
      mockSendSignInEmail.mockClear()
      await auth.api.sendVerificationOTP({
        body: { email: 'Mixed-Case@Example.COM', type: 'sign-in' },
      })
      expect(mockSendSignInEmail).toHaveBeenCalledTimes(1)
    })
  })
})
