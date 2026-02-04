import type { Auth } from '@/auth/auth'
import { markWaitlistApproved } from '@/auth/utils'
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
 * Check if an email domain is in the auto-approved list
 */
const isAutoApprovedDomain = (email: string): boolean => {
  const domain = email.split('@')[1]?.toLowerCase()
  return domain ? autoApprovedDomains.includes(domain) : false
}

/**
 * Trigger Better Auth's OTP flow for approved users.
 * Marks the email first so the callback uses the 'waitlist-approved' template.
 */
const sendApprovedMagicLinkEmail = async (auth: Auth, email: string): Promise<void> => {
  markWaitlistApproved(email)
  await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
}

export const createWaitlistRoutes = (database: typeof db, auth: Auth) =>
  new Elysia({ prefix: '/waitlist' }).onError(safeErrorHandler).post(
    '/join',
    async ({ body }) => {
      const email = normalizeEmail(body.email)

      // Check if user already has a BetterAuth account (they're "approved" by default)
      const existingUser = await database.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)

      if (existingUser.length > 0) {
        // Trigger OTP flow - sends magic link email for one-click sign-in
        try {
          await sendApprovedMagicLinkEmail(auth, email)
        } catch (error) {
          console.error('Failed to send magic link email', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
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
          // Trigger OTP flow - sends magic link email for one-click sign-in
          try {
            await sendApprovedMagicLinkEmail(auth, email)
          } catch (error) {
            console.error('Failed to send magic link email', {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        } else {
          // Send reminder email (pending status)
          try {
            await sendWaitlistReminderEmail({ email })
          } catch (error) {
            console.error('Failed to send waitlist reminder email', {
              error: error instanceof Error ? error.message : String(error),
            })
          }
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
        try {
          await sendApprovedMagicLinkEmail(auth, email)
        } catch (error) {
          console.error('Failed to send magic link email', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } else {
        try {
          await sendWaitlistJoinedEmail({ email })
        } catch (error) {
          console.error('Failed to send waitlist joined email', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return { success: true }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
      }),
    },
  )
