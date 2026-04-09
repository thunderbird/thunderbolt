import type { Auth } from '@/auth/auth'
import { approveWaitlistEntry, createWaitlistEntry, getUserByEmail, getWaitlistByEmail } from '@/dal'
import type { db } from '@/db/client'
import { normalizeEmail } from '@/lib/email'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'
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

type WaitlistRoutesOptions = {
  database: typeof db
  auth: Auth
  emailService?: WaitlistEmailService
}

// TODO(THU-113): Add proof-of-work challenge (ALTCHA) to rate-limit this unauthenticated endpoint
// without storing client IPs. Until then, resendStrategy: "reuse" in the emailOTP config prevents
// the OTP attempt counter from being reset on each request.
export const createWaitlistRoutes = ({ database, auth, emailService = defaultEmailService }: WaitlistRoutesOptions) =>
  new Elysia({ prefix: '/waitlist' }).onError(safeErrorHandler).post(
    '/join',
    async ({ body }) => {
      const email = normalizeEmail(body.email)

      // Check if user already has a BetterAuth account (they're "approved" by default)
      const existingUser = await getUserByEmail(database, email)

      if (existingUser) {
        await sendApprovedMagicLinkEmail(auth, email)
        return { success: true }
      }

      // Check if email already exists on the waitlist
      const existing = await getWaitlistByEmail(database, email)

      // If entry exists, handle based on status
      if (existing) {
        if (existing.status === 'approved') {
          await sendApprovedMagicLinkEmail(auth, email)
          return { success: true }
        }

        // Pending user - check if they now qualify for auto-approval (e.g., feature deployed after they joined)
        if (isAutoApprovedDomain(email)) {
          await approveWaitlistEntry(database, existing.id)
          await sendApprovedMagicLinkEmail(auth, email)
        } else {
          await emailService.sendReminderEmail({ email })
        }
        return { success: true }
      }

      // Check if email domain is auto-approved
      const isAutoApproved = isAutoApprovedDomain(email)

      // Add new entry to waitlist
      await createWaitlistEntry(database, {
        id: crypto.randomUUID(),
        email,
        status: isAutoApproved ? 'approved' : 'pending',
      })

      // Send appropriate email based on auto-approval status
      if (isAutoApproved) {
        await sendApprovedMagicLinkEmail(auth, email)
      } else {
        await emailService.sendJoinedEmail({ email })
      }
      return { success: true }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
      }),
    },
  )
