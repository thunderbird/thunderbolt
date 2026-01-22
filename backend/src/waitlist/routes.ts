import type { db } from '@/db/client'
import { waitlist } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { sendJoinedWaitlistEmail, sendWaitlistReminderEmail } from './utils'

export const createWaitlistRoutes = (database: typeof db) => {
  return new Elysia({ prefix: '/waitlist' })
    .post(
      '/status',
      async ({ body }) => {
        const email = body.email.toLowerCase().trim()

        const entry = await database
          .select({ status: waitlist.status })
          .from(waitlist)
          .where(eq(waitlist.email, email))
          .limit(1)

        if (entry.length === 0) {
          return { onWaitlist: false }
        }

        return { onWaitlist: true, status: entry[0].status }
      },
      {
        body: t.Object({
          email: t.String({ format: 'email' }),
        }),
      },
    )
    .post(
      '/join',
      async ({ body }) => {
        const email = body.email.toLowerCase().trim()

        // Check if email already exists
        const existing = await database
          .select({ id: waitlist.id })
          .from(waitlist)
          .where(eq(waitlist.email, email))
          .limit(1)

        // If entry exists, send reminder email (prevents email enumeration)
        if (existing.length > 0) {
          try {
            await sendWaitlistReminderEmail({ email })
          } catch (error) {
            console.error('Failed to send waitlist reminder email:', error)
          }

          return { success: true }
        }

        // Add new entry to waitlist
        try {
          await database.insert(waitlist).values({
            id: crypto.randomUUID(),
            email,
            status: 'pending',
          })
        } catch (error) {
          // Handle race condition: concurrent request already inserted this email
          // PostgreSQL unique constraint violation code is '23505'
          const isUniqueViolation =
            error instanceof Error && 'code' in error && (error as Error & { code: string }).code === '23505'

          if (isUniqueViolation) {
            // Another request already inserted - send reminder instead
            try {
              await sendWaitlistReminderEmail({ email })
            } catch (err) {
              console.error('Failed to send waitlist reminder email:', err)
            }

            return { success: true }
          }

          throw error
        }

        try {
          await sendJoinedWaitlistEmail({ email })
        } catch (error) {
          console.error('Failed to send waitlist confirmation email:', error)
        }

        return { success: true }
      },
      {
        body: t.Object({
          email: t.String({ format: 'email' }),
        }),
      },
    )
}
