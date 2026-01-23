import { mock } from 'bun:test'

// Mock email functions BEFORE importing modules that use them
const mockSendSignInEmail = mock(() => Promise.resolve())
const mockSendWaitlistNotReadyEmail = mock(() => Promise.resolve())

mock.module('@/auth/utils', () => ({
  sendSignInEmail: mockSendSignInEmail,
  parseTrustedOrigins: () => ['http://localhost:1420'],
  getValidatedOrigin: () => 'http://localhost:1420',
  buildVerifyUrl: (origin: string, email: string, otp: string) => `${origin}/auth/verify?email=${email}&otp=${otp}`,
  isDeepLinkPlatform: () => false,
}))

mock.module('@/waitlist/utils', () => ({
  sendWaitlistNotReadyEmail: mockSendWaitlistNotReadyEmail,
  sendWaitlistJoinedEmail: mock(() => Promise.resolve()),
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

      await auth.api.sendVerificationOTP({
        body: { email: 'pending@example.com', type: 'sign-in' },
      })

      expect(mockSendSignInEmail).toHaveBeenCalledTimes(0)
      expect(mockSendWaitlistNotReadyEmail).toHaveBeenCalledTimes(1)
    })

    it('should block user not on waitlist with no email sent', async () => {
      await auth.api.sendVerificationOTP({
        body: { email: 'unknown@example.com', type: 'sign-in' },
      })

      // No emails sent - prevents email enumeration
      expect(mockSendSignInEmail).toHaveBeenCalledTimes(0)
      expect(mockSendWaitlistNotReadyEmail).toHaveBeenCalledTimes(0)
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
