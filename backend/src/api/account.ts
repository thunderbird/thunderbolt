import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { deleteUser, revokeDevice } from '@/dal'
import type { db as DbType } from '@/db/client'
import { Elysia } from 'elysia'

/**
 * Account API routes for self-service account deletion.
 * All routes require authentication.
 */
export const createAccountRoutes = (auth: Auth, database: typeof DbType) => {
  return new Elysia({ prefix: '/account' })
    .use(createAuthMacro(auth))
    .post(
      '/devices/:id/revoke',
      async ({ params, set, user }) => {
        await revokeDevice(database, params.id, user.id)
        set.status = 204
      },
      { auth: true },
    )
    .delete(
      '/',
      async ({ set, user }) => {
        // tables have cascade delete on user_id and they will be deleted automatically
        await deleteUser(database, user.id)

        set.status = 204
      },
      { auth: true },
    )
}
