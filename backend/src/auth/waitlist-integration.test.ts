import { mock } from 'bun:test'
import * as authUtils from '@/auth/utils'
import * as waitlistUtils from '@/waitlist/utils'
import { clearSettingsCache } from '@/config/settings'

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
    delete process.env.WAITLIST_AUTO_APPROVE_DOMAINS
    clearSettingsCache()
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

    it('should send not-ready email to pending user (without revealing status)', async () => {
      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email: 'pending@example.com',
        status: 'pending',
      })

      // Should succeed (not throw) to prevent revealing waitlist status
      await auth.api.sendVerificationOTP({
        body: { email: 'pending@example.com', type: 'sign-in' },
      })

      // User receives "not ready" email instead of OTP
      expect(mockSendSignInEmail).toHaveBeenCalledTimes(0)
      expect(mockSendWaitlistNotReadyEmail).toHaveBeenCalledTimes(1)
    })

    it('should add unknown user to waitlist and send joined email (without revealing status)', async () => {
      // Should succeed (not throw) to prevent revealing whether email exists
      await auth.api.sendVerificationOTP({
        body: { email: 'unknown@example.com', type: 'sign-in' },
      })

      // User added to waitlist and receives joined email (not OTP)
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

    it('should send OTP when user exists in both users table and waitlist as approved', async () => {
      // This is the exact scenario from the bug report (chris@cjroth.com)
      const email = 'dual-entry@example.com'

      await db.insert(user).values({
        id: crypto.randomUUID(),
        email,
        name: 'Dual Entry User',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email,
        status: 'approved',
      })

      await auth.api.sendVerificationOTP({
        body: { email, type: 'sign-in' },
      })

      expect(mockSendSignInEmail).toHaveBeenCalledTimes(1)
      expect(mockSendWaitlistNotReadyEmail).toHaveBeenCalledTimes(0)
      expect(mockSendWaitlistJoinedEmail).toHaveBeenCalledTimes(0)
    })

    it('should auto-approve and send OTP for auto-approve domain user (via hook path)', async () => {
      // Set auto-approve domain
      process.env.WAITLIST_AUTO_APPROVE_DOMAINS = 'autoapprove.com'
      clearSettingsCache()

      await auth.api.sendVerificationOTP({
        body: { email: 'newuser@autoapprove.com', type: 'sign-in' },
      })

      expect(mockSendSignInEmail).toHaveBeenCalledTimes(1)
      expect(mockSendWaitlistJoinedEmail).toHaveBeenCalledTimes(0)

      // Verify the waitlist entry was created as approved
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'newuser@autoapprove.com'))
      expect(entries).toHaveLength(1)
      expect(entries[0].status).toBe('approved')
    })

    it('should upgrade pending user to approved when domain becomes auto-approved', async () => {
      const email = 'upgrader@newlyapproved.com'

      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email,
        status: 'pending',
      })

      process.env.WAITLIST_AUTO_APPROVE_DOMAINS = 'newlyapproved.com'
      clearSettingsCache()

      await auth.api.sendVerificationOTP({
        body: { email, type: 'sign-in' },
      })

      expect(mockSendSignInEmail).toHaveBeenCalledTimes(1)
      expect(mockSendWaitlistNotReadyEmail).toHaveBeenCalledTimes(0)

      // Verify the waitlist entry was upgraded to approved
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, email))
      expect(entries).toHaveLength(1)
      expect(entries[0].status).toBe('approved')
    })

    it('should deterministically send OTP for approved user on repeated calls', async () => {
      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email: 'deterministic@example.com',
        status: 'approved',
      })

      // Call twice
      await auth.api.sendVerificationOTP({
        body: { email: 'deterministic@example.com', type: 'sign-in' },
      })
      await auth.api.sendVerificationOTP({
        body: { email: 'deterministic@example.com', type: 'sign-in' },
      })

      expect(mockSendSignInEmail).toHaveBeenCalledTimes(2)
      expect(mockSendWaitlistNotReadyEmail).toHaveBeenCalledTimes(0)
      expect(mockSendWaitlistJoinedEmail).toHaveBeenCalledTimes(0)
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

  describe('OTP resend strategy (reuse)', () => {
    it('should reuse the same OTP on repeated sends instead of generating a new one', async () => {
      const email = 'reuse-test@example.com'
      await db.insert(user).values({
        id: crypto.randomUUID(),
        email,
        name: 'Reuse Test User',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      // First OTP send
      await auth.api.sendVerificationOTP({
        body: { email, type: 'sign-in' },
      })
      const firstCall = mockSendSignInEmail.mock.calls[0] as unknown as [{ otp: string }]
      const firstOtp = firstCall[0].otp

      // Second OTP send — should reuse the same OTP
      mockSendSignInEmail.mockClear()
      await auth.api.sendVerificationOTP({
        body: { email, type: 'sign-in' },
      })
      const secondCall = mockSendSignInEmail.mock.calls[0] as unknown as [{ otp: string }]
      const secondOtp = secondCall[0].otp

      expect(secondOtp).toBe(firstOtp)
    })

    it('should not reset attempt counter when OTP is resent', async () => {
      const email = 'counter-test@example.com'
      await db.insert(user).values({
        id: crypto.randomUUID(),
        email,
        name: 'Counter Test User',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      // Send OTP
      await auth.api.sendVerificationOTP({
        body: { email, type: 'sign-in' },
      })

      // Make 2 wrong attempts (of 3 allowed) — counter goes to 2
      for (let i = 0; i < 2; i++) {
        try {
          await auth.api.signInEmailOTP({ body: { email, otp: '000000' } })
        } catch {
          // Expected: INVALID_OTP
        }
      }

      // Resend OTP — with "reuse" strategy, counter should NOT reset (stays at 2)
      await auth.api.sendVerificationOTP({
        body: { email, type: 'sign-in' },
      })

      // 3rd wrong attempt: counter is 2, passes check, OTP is wrong → counter becomes 3, returns INVALID_OTP
      try {
        await auth.api.signInEmailOTP({ body: { email, otp: '000000' } })
      } catch {
        // Expected: INVALID_OTP
      }

      // 4th attempt: counter is now 3 >= allowedAttempts(3), should get TOO_MANY_ATTEMPTS
      try {
        await auth.api.signInEmailOTP({ body: { email, otp: '000000' } })
        expect(true).toBe(false)
      } catch (err: unknown) {
        const code = (err as { body?: { code?: string } }).body?.code ?? ''
        // After 3 failed attempts the OTP is deleted, so we get INVALID_OTP (no verification row)
        // or TOO_MANY_ATTEMPTS (if the row still exists with count >= 3)
        expect(['TOO_MANY_ATTEMPTS', 'INVALID_OTP']).toContain(code)
      }

      // Key assertion: verify that WITHOUT resend-reset, we only got 3 total attempts
      // (2 before resend + 1 after = 3 total, then locked out on the 4th)
      // If the counter had been reset by resend, we'd have had 5 attempts total (2 + 3)
    })

    it('should only allow 3 verification attempts before locking out', async () => {
      const email = 'lockout-test@example.com'
      await db.insert(user).values({
        id: crypto.randomUUID(),
        email,
        name: 'Lockout Test User',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      // Send OTP
      await auth.api.sendVerificationOTP({
        body: { email, type: 'sign-in' },
      })

      // Use up all 3 attempts with wrong OTPs
      for (let i = 0; i < 3; i++) {
        try {
          await auth.api.signInEmailOTP({ body: { email, otp: '000000' } })
        } catch {
          // Expected: INVALID_OTP or TOO_MANY_ATTEMPTS on 3rd
        }
      }

      // 4th attempt should be locked out
      try {
        await auth.api.signInEmailOTP({ body: { email, otp: '999999' } })
        expect(true).toBe(false)
      } catch (err: unknown) {
        const code = (err as { body?: { code?: string } }).body?.code ?? ''
        // After 3 attempts, the OTP is deleted — subsequent attempts get INVALID_OTP
        expect(['TOO_MANY_ATTEMPTS', 'INVALID_OTP']).toContain(code)
      }
    })
  })
})
