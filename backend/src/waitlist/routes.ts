import type { Auth } from '@/auth/auth'
import { clearWaitlistApproved, markWaitlistApproved } from '@/auth/utils'
import type { db } from '@/db/client'
import { user } from '@/db/auth-schema'
import { waitlist } from '@/db/schema'
import { normalizeEmail } from '@/lib/email'
import { safeErrorHandler } from '@/middleware/error-handling'
import { autoApprovedDomains } from '@/lib/constants'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { sendWaitlistJoinedEmail, sendWaitlistReminderEmail } from './utils'

/**
 * Check if an email domain is in the auto-approved list.
 * Uses the last @ character to handle edge-case RFC 5321 addresses with quoted local parts.
 */
const isAutoApprovedDomain = (email: string): boolean => {
  const parts = email.split('@')
  const domain = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : null
  return domain ? autoApprovedDomains.includes(domain) : false
}

/**
 * Trigger Better Auth's OTP flow for approved users.
 * Marks the email first so the callback uses the 'waitlist-approved' template.
 * Clears the flag if OTP send fails to prevent incorrect template on future sends.
 */
const sendApprovedMagicLinkEmail = async (auth: Auth, email: string): Promise<void> => {
  markWaitlistApproved(email)
  try {
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
  } catch (error) {
    clearWaitlistApproved(email)
    throw error
  }
}

export const createWaitlistRoutes = (database: typeof db, auth: Auth) =>
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

      // If entry exists, send appropriate email based on status
      if (existing.length > 0) {
        if (existing[0].status === 'approved') {
          await sendApprovedMagicLinkEmail(auth, email)
        } else {
          await sendWaitlistReminderEmail({ email })
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
        await sendWaitlistJoinedEmail({ email })
      }
      return { success: true }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
      }),
    },
  )
