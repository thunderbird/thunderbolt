import type { db } from '@/db/client'
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

      // Check if email already exists
      const existing = await database
        .select({ id: waitlist.id })
        .from(waitlist)
        .where(eq(waitlist.email, email))
        .limit(1)

      // If entry exists, send reminder email (prevents email enumeration)
      if (existing.length > 0) {
        await sendWaitlistReminderEmail({ email })
        return { success: true }
      }

      // Add new entry to waitlist
      await database.insert(waitlist).values({
        id: crypto.randomUUID(),
        email,
        status: 'pending',
      })

      await sendWaitlistJoinedEmail({ email })
      return { success: true }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
      }),
    },
  )
