import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { getSettings } from '@/config/settings'
import { deleteUser, revokeDevice } from '@/dal'
import type { db as DbType } from '@/db/client'
import { createOriginValidation } from '@/middleware/origin-validation'
import { Elysia } from 'elysia'

/** Account API routes. All routes require authentication and Origin validation. */
export const createAccountRoutes = (auth: Auth, database: typeof DbType) => {
  const settings = getSettings()
  return new Elysia({ prefix: '/account' })
    .use(createOriginValidation(settings))
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
