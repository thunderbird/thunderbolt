import type { db } from '@/db/client'
import { waitlist } from '@/db/schema'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { sendWaitlistConfirmationEmail, sendWaitlistReminderEmail } from './utils'

export const createWaitlistRoutes = (database: typeof db) => {
  return new Elysia({ prefix: '/waitlist' })
    .post(
      '/status',
      async ({ body }) => {
        const email = body.email.toLowerCase().trim()

        const entry = await database
          .select({ status: waitlist.status })
          .from(waitlist)
          .where(and(eq(waitlist.email, email), isNull(waitlist.deletedAt)))
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

        // Check if email already exists (active entry)
        const existingActive = await database
          .select({ id: waitlist.id })
          .from(waitlist)
          .where(and(eq(waitlist.email, email), isNull(waitlist.deletedAt)))
          .limit(1)

        // If active entry exists, send reminder email (no email enumeration in UI)
        if (existingActive.length > 0) {
          sendWaitlistReminderEmail({
            email,
            isProduction: process.env.NODE_ENV === 'production',
          }).catch((error) => {
            console.error('Failed to send waitlist reminder email:', error)
          })

          return { success: true }
        }

        // Check if email was soft-deleted (can be reactivated)
        const existingDeleted = await database
          .select({ id: waitlist.id })
          .from(waitlist)
          .where(and(eq(waitlist.email, email), isNotNull(waitlist.deletedAt)))
          .limit(1)

        if (existingDeleted.length > 0) {
          // Reactivate soft-deleted entry
          await database
            .update(waitlist)
            .set({
              deletedAt: null,
              status: 'pending',
              updatedAt: new Date(),
            })
            .where(eq(waitlist.id, existingDeleted[0].id))
        } else {
          // Add new entry to waitlist
          await database.insert(waitlist).values({
            id: crypto.randomUUID(),
            email,
            status: 'pending',
          })
        }

        // Send confirmation email (fire and forget - don't block response)
        sendWaitlistConfirmationEmail({
          email,
          isProduction: process.env.NODE_ENV === 'production',
        }).catch((error) => {
          console.error('Failed to send waitlist confirmation email:', error)
        })

        return { success: true }
      },
      {
        body: t.Object({
          email: t.String({ format: 'email' }),
        }),
      },
    )
}
