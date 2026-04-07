import type { Auth } from '@/auth/elysia-plugin'
import { deleteUser, revokeDevice } from '@/dal'
import type { db as DbType } from '@/db/client'
import { createSessionGuard } from '@/middleware/session-guard'
import { Elysia } from 'elysia'

/**
 * Account API routes for self-service account deletion.
 * All routes require authentication.
 */
export const createAccountRoutes = (auth: Auth, database: typeof DbType) => {
  return new Elysia({ prefix: '/account' })
    .use(createSessionGuard(auth))
    .post('/devices/:id/revoke', async ({ params, set, user: sessionUser }) => {
      const userId = sessionUser!.id
      await revokeDevice(database, params.id, userId)
      set.status = 204
    })
    .delete('/', async ({ set, user: sessionUser }) => {
      const userId = sessionUser!.id

      // tables have cascade delete on user_id and they will be deleted automatically
      await deleteUser(database, userId)

      set.status = 204
    })
}
