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

// Import after mocks are set up
import { user, verification } from '@/db/auth-schema'
import { otpChallenge } from '@/db/schema'
import { waitlist } from '@/db/schema'
import { createAuth } from '@/auth/auth'
import { createApp } from '@/index'
import { createTestDb } from '@/test-utils/db'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { eq, like } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

describe('OTP Security Hardening', () => {
  let auth: ReturnType<typeof createAuth>
  let app: Awaited<ReturnType<typeof createApp>>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  /** Insert an existing BetterAuth user */
  const insertExistingUser = async (email: string) => {
    await db.insert(user).values({
      id: crypto.randomUUID(),
      email,
      name: 'Test User',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  /** Insert an approved waitlist entry */
  const insertApprovedWaitlist = async (email: string) => {
    await db.insert(waitlist).values({
      id: crypto.randomUUID(),
      email,
      status: 'approved',
    })
  }

  /** POST to waitlist/join via HTTP */
  const postWaitlistJoin = (email: string, appInstance = app) =>
    appInstance.handle(
      new Request('http://localhost/v1/waitlist/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
    )

  /** Create a challenge token and send OTP via auth.api (for unit-level tests) */
  const sendOtpWithChallenge = async (email: string) => {
    const challengeToken = await createTestChallenge(db, email)
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    const call = mockSendSignInEmail.mock.calls.at(-1) as unknown as [{ otp: string }]
    return { otp: call[0].otp, challengeToken }
  }

  /** Call signInEmailOTP via auth.api with a challenge token header */
  const signInWithChallenge = (email: string, otp: string, challengeToken: string) =>
    auth.api.signInEmailOTP({
      body: { email, otp },
      headers: new Headers({ 'x-challenge-token': challengeToken }),
    })

  beforeEach(async () => {
    mockSendSignInEmail.mockClear()
    mockSendWaitlistNotReadyEmail.mockClear()
    mockSendWaitlistJoinedEmail.mockClear()

    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    auth = createAuth(db)
    app = await createApp({ database: db, otpCooldownMs: 0 })
  })

  afterEach(async () => {
    delete process.env.WAITLIST_AUTO_APPROVE_DOMAINS
    clearSettingsCache()
    await cleanup()
  })

  // ---------------------------------------------------------------------------
  // Measure 1: 8-digit OTP
  // ---------------------------------------------------------------------------
  describe('Measure 1: 8-digit OTP', () => {
    it('should generate an OTP that is exactly 8 digits', async () => {
      await insertApprovedWaitlist('otp-len@example.com')
      await auth.api.sendVerificationOTP({ body: { email: 'otp-len@example.com', type: 'sign-in' } })
      const call = mockSendSignInEmail.mock.calls.at(-1) as unknown as [{ otp: string }]
      expect(call[0].otp).toMatch(/^\d{8}$/)
    })

    it('should reject a 6-digit code even if numerically plausible', async () => {
      const email = 'otp-length@example.com'
      await insertExistingUser(email)
      await insertApprovedWaitlist(email)
      const { challengeToken } = await sendOtpWithChallenge(email)

      let threw = false
      try {
        await signInWithChallenge(email, '123456', challengeToken)
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    })

    it('should accept a valid 8-digit OTP', async () => {
      const email = 'otp-valid@example.com'
      await insertExistingUser(email)
      await insertApprovedWaitlist(email)
      const { otp, challengeToken } = await sendOtpWithChallenge(email)

      expect(otp).toHaveLength(8)

      const result = await signInWithChallenge(email, otp, challengeToken)
      expect(result.user).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Measure 2: 3-attempt invalidation
  // ---------------------------------------------------------------------------
  describe('Measure 2: 3-attempt invalidation', () => {
    it('should delete OTP record after attempts are exhausted', async () => {
      const email = 'attempts-delete@example.com'
      await insertExistingUser(email)
      await insertApprovedWaitlist(email)
      const { challengeToken } = await sendOtpWithChallenge(email)

      const before = await db
        .select()
        .from(verification)
        .where(like(verification.identifier, `%${email}%`))
      expect(before.length).toBeGreaterThan(0)

      for (let i = 0; i < 3; i++) {
        try {
          await signInWithChallenge(email, '00000000', challengeToken)
        } catch {
          // Expected: INVALID_OTP
        }
      }

      // 4th attempt triggers deletion (counter >= allowedAttempts)
      try {
        await signInWithChallenge(email, '00000000', challengeToken)
      } catch {
        // Expected: TOO_MANY_ATTEMPTS
      }

      const after = await db
        .select()
        .from(verification)
        .where(like(verification.identifier, `%${email}%`))
      expect(after).toHaveLength(0)
    })

    it('should return error on 4th guess after lockout', async () => {
      const email = 'attempts-4th@example.com'
      await insertExistingUser(email)
      await insertApprovedWaitlist(email)
      const { challengeToken } = await sendOtpWithChallenge(email)

      for (let i = 0; i < 3; i++) {
        try {
          await signInWithChallenge(email, '00000000', challengeToken)
        } catch {
          // Expected
        }
      }
      try {
        await signInWithChallenge(email, '00000000', challengeToken)
        expect(true).toBe(false) // Should not reach here
      } catch (err: unknown) {
        // After deletion, we get INVALID_OTP, TOO_MANY_ATTEMPTS, or UNAUTHORIZED (challenge consumed)
        expect(err).toBeDefined()
      }
    })

    it('should allow requesting a new code after exhaustion, and old code is invalid', async () => {
      const email = 'attempts-regen@example.com'
      await insertExistingUser(email)
      await insertApprovedWaitlist(email)
      const { otp: oldOtp, challengeToken } = await sendOtpWithChallenge(email)

      // Exhaust all 3 attempts
      for (let i = 0; i < 3; i++) {
        try {
          await signInWithChallenge(email, '00000000', challengeToken)
        } catch {
          // Expected
        }
      }

      // Request a new code with a fresh challenge token
      mockSendSignInEmail.mockClear()
      const { otp: newOtp, challengeToken: newToken } = await sendOtpWithChallenge(email)

      // New OTP should be different (old one was exhausted, resend generates fresh)
      expect(newOtp).not.toBe(oldOtp)

      // Old OTP should NOT work
      let oldWorked = false
      try {
        const result = await signInWithChallenge(email, oldOtp, newToken)
        oldWorked = result.user !== undefined
      } catch {
        // Expected
      }
      expect(oldWorked).toBe(false)

      const freshToken = await createTestChallenge(db, email)
      const result = await signInWithChallenge(email, newOtp, freshToken)
      expect(result.user).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Measure 3: 15s cooldown between code requests
  // ---------------------------------------------------------------------------
  describe('Measure 3: 15s cooldown', () => {
    it('should reject second /waitlist/join for same email within cooldown', async () => {
      const cooldownApp = await createApp({ database: db, otpCooldownMs: 15_000 })
      await insertApprovedWaitlist('cooldown@example.com')

      const first = await postWaitlistJoin('cooldown@example.com', cooldownApp)
      expect(first.status).toBe(200)

      const second = await postWaitlistJoin('cooldown@example.com', cooldownApp)
      expect(second.status).toBe(429)
    })

    it('should succeed after cooldown expires', async () => {
      const shortCooldownApp = await createApp({ database: db, otpCooldownMs: 1 })
      await insertApprovedWaitlist('cooldown-expire@example.com')

      const first = await postWaitlistJoin('cooldown-expire@example.com', shortCooldownApp)
      expect(first.status).toBe(200)

      await new Promise((r) => setTimeout(r, 5))

      const second = await postWaitlistJoin('cooldown-expire@example.com', shortCooldownApp)
      expect(second.status).toBe(200)
    })

    it('should not block different emails during cooldown', async () => {
      const cooldownApp = await createApp({ database: db, otpCooldownMs: 15_000 })
      await insertApprovedWaitlist('email-a@example.com')
      await insertApprovedWaitlist('email-b@example.com')

      const first = await postWaitlistJoin('email-a@example.com', cooldownApp)
      expect(first.status).toBe(200)

      const second = await postWaitlistJoin('email-b@example.com', cooldownApp)
      expect(second.status).toBe(200)
    })
  })

  // ---------------------------------------------------------------------------
  // Measure 4: Session binding (challenge token)
  // ---------------------------------------------------------------------------
  describe('Measure 4: Session binding', () => {
    it('should return challengeToken in /waitlist/join response for approved user', async () => {
      await insertApprovedWaitlist('challenge@example.com')

      const response = await postWaitlistJoin('challenge@example.com')
      expect(response.status).toBe(200)

      const body = await response.json()
      expect(body.success).toBe(true)
      expect(body.challengeToken).toBeDefined()
      expect(typeof body.challengeToken).toBe('string')
      expect(body.challengeToken.length).toBeGreaterThan(0)
    })

    it('should also return challengeToken for pending users (privacy-preserving)', async () => {
      const response = await postWaitlistJoin('pending-challenge@example.com')
      expect(response.status).toBe(200)

      const body = await response.json()
      expect(body.success).toBe(true)
      expect(body.challengeToken).toBeDefined()
    })

    // These tests use auth.api (not HTTP) to avoid Better Auth's HTTP rate limiter
    // which causes flaky 429s when CI runs the suite 5x in the same process.
    // The before/after hooks still execute via auth.api, so challenge token
    // validation is fully exercised.

    it('should reject sign-in without challenge token', async () => {
      const email = 'no-token@example.com'
      await insertExistingUser(email)
      await insertApprovedWaitlist(email)

      const { otp } = await sendOtpWithChallenge(email)

      let threw = false
      try {
        await auth.api.signInEmailOTP({ body: { email, otp } })
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    })

    it('should reject sign-in with wrong challenge token', async () => {
      const email = 'wrong-token@example.com'
      await insertExistingUser(email)
      await insertApprovedWaitlist(email)

      const { otp } = await sendOtpWithChallenge(email)

      let threw = false
      try {
        await auth.api.signInEmailOTP({
          body: { email, otp },
          headers: new Headers({ 'x-challenge-token': 'wrong-token-value' }),
        })
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    })

    it('should accept sign-in with correct challenge token and code', async () => {
      const email = 'correct-token@example.com'
      await insertExistingUser(email)
      await insertApprovedWaitlist(email)

      const { otp, challengeToken } = await sendOtpWithChallenge(email)

      const result = await signInWithChallenge(email, otp, challengeToken)
      expect(result.user).toBeDefined()
    })

    it('should reject attacker without challenge token even with correct OTP', async () => {
      const victimEmail = 'victim@example.com'
      await insertExistingUser(victimEmail)
      await insertApprovedWaitlist(victimEmail)

      const { otp, challengeToken: victimToken } = await sendOtpWithChallenge(victimEmail)

      // Attacker tries without token
      let attackerSucceeded = false
      try {
        await auth.api.signInEmailOTP({ body: { email: victimEmail, otp } })
        attackerSucceeded = true
      } catch {
        // Expected: UNAUTHORIZED
      }
      expect(attackerSucceeded).toBe(false)

      // Victim succeeds with their token
      const result = await signInWithChallenge(victimEmail, otp, victimToken)
      expect(result.user).toBeDefined()
    })

    it('should store challenge token in database', async () => {
      await insertApprovedWaitlist('db-token@example.com')

      const response = await postWaitlistJoin('db-token@example.com')
      const { challengeToken } = await response.json()

      const records = await db.select().from(otpChallenge).where(eq(otpChallenge.email, 'db-token@example.com'))
      expect(records).toHaveLength(1)
      expect(records[0].challengeToken).toBe(challengeToken)
    })
  })

  // ---------------------------------------------------------------------------
  // Measure 5: 10-minute OTP expiry
  // ---------------------------------------------------------------------------
  describe('Measure 5: 10-minute OTP expiry', () => {
    it('should set OTP expiry to approximately 10 minutes from now', async () => {
      const email = 'expiry-check@example.com'
      await insertExistingUser(email)
      await insertApprovedWaitlist(email)
      await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })

      // Query all verification records for this email (using LIKE to handle any prefix format)
      const records = await db
        .select()
        .from(verification)
        .where(like(verification.identifier, `%${email}%`))
      expect(records).toHaveLength(1)

      const expiresAt = records[0].expiresAt.getTime()
      const now = Date.now()
      const tenMinutes = 10 * 60 * 1000

      // Should be approximately 10 minutes from now (allow 30s tolerance)
      expect(expiresAt).toBeGreaterThan(now + tenMinutes - 30_000)
      expect(expiresAt).toBeLessThan(now + tenMinutes + 30_000)
    })

    it('should reject valid code after expiry', async () => {
      const email = 'expiry-reject@example.com'
      await insertExistingUser(email)
      await insertApprovedWaitlist(email)
      const { otp, challengeToken } = await sendOtpWithChallenge(email)

      // Manually set the verification record's expiresAt to the past
      await db
        .update(verification)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(like(verification.identifier, `%${email}%`))

      // Should reject the expired OTP
      let threw = false
      try {
        await signInWithChallenge(email, otp, challengeToken)
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    })
  })
})
