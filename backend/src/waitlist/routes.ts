import type { Auth } from '@/auth/auth'
import type { db } from '@/db/client'
import { user } from '@/db/auth-schema'
import { waitlist } from '@/db/schema'
import { normalizeEmail } from '@/lib/email'
import { safeErrorHandler } from '@/middleware/error-handling'
import { autoApprovedDomains } from '@/lib/constants'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import {
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

/**
 * Check if an email domain is in the auto-approved list.
 * Uses the last @ character to handle edge-case RFC 5321 addresses with quoted local parts.
 */
const isAutoApprovedDomain = (email: string): boolean => {
  const parts = email.split('@')
  const domain = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : null
  return domain ? autoApprovedDomains.includes(domain) : false
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

export const createWaitlistRoutes = ({ database, auth, emailService = defaultEmailService }: WaitlistRoutesOptions) =>
  new Elysia({ prefix: '/waitlist' }).onError(safeErrorHandler).post(
    '/join',
    async ({ body }) => {
      const email = normalizeEmail(body.email)

      // Check if user already has a BetterAuth account (they're "approved" by default)
      const existingUser = await database.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)

      if (existingUser.length > 0) {
        await sendApprovedMagicLinkEmail(auth, email)
        return { success: true }
      }

      // Check if email already exists on the waitlist
      const existing = await database
        .select({ id: waitlist.id, status: waitlist.status })
        .from(waitlist)
        .where(eq(waitlist.email, email))
        .limit(1)

      // If entry exists, handle based on status
      if (existing.length > 0) {
        if (existing[0].status === 'approved') {
          await sendApprovedMagicLinkEmail(auth, email)
          return { success: true }
        }

        // Pending user - check if they now qualify for auto-approval (e.g., feature deployed after they joined)
        if (isAutoApprovedDomain(email)) {
          await database.update(waitlist).set({ status: 'approved' }).where(eq(waitlist.id, existing[0].id))
          await sendApprovedMagicLinkEmail(auth, email)
        } else {
          await emailService.sendReminderEmail({ email })
        }
        return { success: true }
      }

      // Check if email domain is auto-approved
      const isAutoApproved = isAutoApprovedDomain(email)

      // Add new entry to waitlist
      await database.insert(waitlist).values({
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
