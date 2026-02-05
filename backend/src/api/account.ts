import type { Auth } from '@/auth/elysia-plugin'
import type { db as DbType } from '@/db/client'
import { user } from '@/db/auth-schema'
import { devicesTable, POWERSYNC_TABLES_BY_NAME } from '@/db/schema'
import { POWERSYNC_TABLE_NAMES } from '@shared/powersync-tables'
import { and, eq } from 'drizzle-orm'
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
    .post('/devices/:id/revoke', async ({ params, set, user: sessionUser }) => {
      const userId = sessionUser!.id
      const deviceId = params.id
      const now = Math.floor(Date.now() / 1000)
      await database
        .update(devicesTable)
        .set({ revokedAt: now })
        .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId)))
      set.status = 204
    })
    .delete('/', async ({ set, user: sessionUser }) => {
      const userId = sessionUser!.id

      await database.transaction(async (tx) => {
        for (const name of POWERSYNC_TABLE_NAMES) {
          const table = POWERSYNC_TABLES_BY_NAME[name]
          await tx.delete(table).where(eq(table.userId, userId))
        }
        await tx.delete(user).where(eq(user.id, userId))
      })

      set.status = 204
    })
}
