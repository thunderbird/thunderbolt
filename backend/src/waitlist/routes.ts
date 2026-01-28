import type { db } from '@/db/client'
import { user } from '@/db/auth-schema'
import { waitlist } from '@/db/schema'
import { normalizeEmail } from '@/lib/email'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { sendWaitlistJoinedEmail, sendWaitlistReminderEmail } from './utils'

export const createWaitlistRoutes = (database: typeof db) =>
  new Elysia({ prefix: '/waitlist' }).post(
    '/join',
    async ({ body }) => {
      const email = normalizeEmail(body.email)

      // Check if user already has a BetterAuth account (existing users bypass waitlist)
      const existingUser = await database.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)

      if (existingUser.length > 0) {
        return { success: true, approved: true }
      }

      // Check if email already exists on the waitlist
      const existing = await database
        .select({ id: waitlist.id, status: waitlist.status })
        .from(waitlist)
        .where(eq(waitlist.email, email))
        .limit(1)

      // If entry exists, check if approved
      if (existing.length > 0) {
        // If approved, tell frontend to redirect to sign-in
        if (existing[0].status === 'approved') {
          return { success: true, approved: true }
        }

        // Otherwise send reminder email (prevents email enumeration)
        try {
          await sendWaitlistReminderEmail({ email })
        } catch (error) {
          console.error('Failed to send waitlist reminder email', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return { success: true, approved: false }
      }

      // Add new entry to waitlist
      await database.insert(waitlist).values({
        id: crypto.randomUUID(),
        email,
        status: 'pending',
      })

      try {
        await sendWaitlistJoinedEmail({ email })
      } catch (error) {
        console.error('Failed to send waitlist joined email', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return { success: true, approved: false }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
      }),
    },
  )
