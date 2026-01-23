import type { db } from '@/db/client'
import { waitlist } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { sendWaitlistJoinedEmail, sendWaitlistReminderEmail } from './utils'

export const createWaitlistRoutes = (database: typeof db) =>
  new Elysia({ prefix: '/waitlist' }).post(
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
        await sendWaitlistReminderEmail({ email })
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
          await sendWaitlistReminderEmail({ email })
          return { success: true }
        }

        throw error
      }

      await sendWaitlistJoinedEmail({ email })
      return { success: true }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
      }),
    },
  )
