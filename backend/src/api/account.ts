import type { Auth } from '@/auth/elysia-plugin'
import type { db as DbType } from '@/db/client'
import { user } from '@/db/auth-schema'
import { devicesTable } from '@/db/schema'
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
      const now = new Date()
      await database
        .update(devicesTable)
        .set({ revokedAt: now })
        .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId)))
      set.status = 204
    })
    .delete('/', async ({ set, user: sessionUser }) => {
      const userId = sessionUser!.id

      // tables have cascade delete on user_id and they will be deleted automatically
      await database.delete(user).where(eq(user.id, userId))

      set.status = 204
    })
}
