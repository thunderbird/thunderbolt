import type { Auth } from '@/auth/elysia-plugin'
import type { db as DbType } from '@/db/client'
import { user } from '@/db/auth-schema'
import {
  chatMessagesTable,
  chatThreadsTable,
  modelsTable,
  mcpServersTable,
  promptsTable,
  settingsTable,
  tasksTable,
  triggersTable,
} from '@/db/schema'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'

/**
 * Account API routes for self-service account deletion.
 * All routes require authentication.
 */
export const createAccountRoutes = (auth: Auth, database: typeof DbType) => {
  return new Elysia({ prefix: '/account' })
    .derive(async ({ request, set }) => {
      const session = await auth.api.getSession({ headers: request.headers })

      if (!session) {
        set.status = 401
        return { user: null }
      }

      return { user: session.user }
    })
    .onBeforeHandle(({ user: sessionUser, set }) => {
      if (!sessionUser) {
        set.status = 401
        return { error: 'Unauthorized' }
      }
    })
    .delete('/', async ({ set, user: sessionUser }) => {
      const userId = sessionUser!.id

      await database.transaction(async (tx) => {
        await tx.delete(settingsTable).where(eq(settingsTable.userId, userId))
        await tx.delete(chatMessagesTable).where(eq(chatMessagesTable.userId, userId))
        await tx.delete(chatThreadsTable).where(eq(chatThreadsTable.userId, userId))
        await tx.delete(tasksTable).where(eq(tasksTable.userId, userId))
        await tx.delete(triggersTable).where(eq(triggersTable.userId, userId))
        await tx.delete(promptsTable).where(eq(promptsTable.userId, userId))
        await tx.delete(mcpServersTable).where(eq(mcpServersTable.userId, userId))
        await tx.delete(modelsTable).where(eq(modelsTable.userId, userId))
        await tx.delete(user).where(eq(user.id, userId))
      })

      set.status = 204
    })
}
