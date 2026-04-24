import { otpExpiryMs } from '@/auth/otp-constants'
import type { Auth } from '@/auth/auth'
import {
  approveWaitlistEntry,
  getOrCreateOtpChallenge,
  createWaitlistEntry,
  getUserByEmail,
  getWaitlistByEmail,
} from '@/dal'
import type { db } from '@/db/client'
import { normalizeEmail } from '@/lib/email'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, type AnyElysia, t } from 'elysia'
import {
  isAutoApprovedDomain,
  sendWaitlistJoinedEmail as defaultSendJoinedEmail,
  sendWaitlistReminderEmail as defaultSendReminderEmail,
} from './utils'

/**
 * Email service interface for dependency injection.
 * Allows tests to provide fake implementations without module mocking.
 */
export type WaitlistEmailService = {
  sendJoinedEmail: (params: { email: string }) => Promise<void>
  sendReminderEmail: (params: { email: string }) => Promise<void>
}

const defaultEmailService: WaitlistEmailService = {
  sendJoinedEmail: defaultSendJoinedEmail,
  sendReminderEmail: defaultSendReminderEmail,
}

/** Trigger Better Auth's OTP flow for approved users. */
const sendApprovedMagicLinkEmail = async (auth: Auth, email: string): Promise<void> => {
  await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
}

/**
 * Resolve whether an email is approved to receive an OTP.
 * Handles side effects (creating waitlist entries, sending emails) along the way.
 * Returns true for existing users, approved waitlist entries, and auto-approved domains.
 */
const resolveApproval = async (
  database: typeof db,
  email: string,
  emailService: WaitlistEmailService,
): Promise<boolean> => {
  const existingUser = await getUserByEmail(database, email)
  if (existingUser) return true

  const existing = await getWaitlistByEmail(database, email)

  if (existing) {
    if (existing.status === 'approved') return true

    if (isAutoApprovedDomain(email)) {
      await approveWaitlistEntry(database, existing.id)
      return true
    }

    await emailService.sendReminderEmail({ email })
    return false
  }

  const autoApproved = isAutoApprovedDomain(email)
  await createWaitlistEntry(database, {
    id: crypto.randomUUID(),
    email,
    status: autoApproved ? 'approved' : 'pending',
  })

  if (autoApproved) return true

  await emailService.sendJoinedEmail({ email })
  return false
}

/** Default cooldown between OTP requests per email (15 seconds). */
const DEFAULT_COOLDOWN_MS = 15_000

type WaitlistRoutesOptions = {
  database: typeof db
  auth: Auth
  emailService?: WaitlistEmailService
  /** Cooldown between OTP requests per email in ms. Default: 15000. Set to 0 to disable. */
  cooldownMs?: number
  ipRateLimit?: AnyElysia
}

export const createWaitlistRoutes = ({
  database,
  auth,
  emailService = defaultEmailService,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  ipRateLimit,
}: WaitlistRoutesOptions) => {
  // Per-instance cooldown tracker. Tracks when the last OTP request was made for each email
  // to prevent rapid code cycling. In-memory is appropriate: 15s window, single-instance defense.
  const emailCooldowns = new Map<string, number>()

  const app = new Elysia({ prefix: '/waitlist' }).onError(safeErrorHandler)
  if (ipRateLimit) {
    app.use(ipRateLimit)
  }

  return app.post(
    '/join',
    async ({ body, set }) => {
      const email = normalizeEmail(body.email)

      if (cooldownMs > 0) {
        const now = Date.now()
        const lastRequest = emailCooldowns.get(email)
        if (lastRequest && now - lastRequest < cooldownMs) {
          set.status = 429
          return {
            error: 'code_already_sent',
            message: 'A verification code was recently sent. Please wait before requesting a new one.',
          }
        }
        // Prune expired entries to prevent unbounded growth
        if (emailCooldowns.size > 1000) {
          for (const [key, ts] of emailCooldowns) {
            if (now - ts >= cooldownMs) emailCooldowns.delete(key)
          }
        }
      }

      // Record cooldown immediately (before any async work) to close the race window
      // where concurrent requests could pass the check before the timestamp is written.
      if (cooldownMs > 0) {
        emailCooldowns.set(email, Date.now())
      }

      const approved = await resolveApproval(database, email, emailService)

      if (!approved) {
        return { success: true }
      }

      const challengeToken = await getOrCreateOtpChallenge(database, {
        id: crypto.randomUUID(),
        email,
        challengeToken: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + otpExpiryMs),
      })
      await sendApprovedMagicLinkEmail(auth, email)
      return { success: true, challengeToken }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
      }),
    },
  )
}
