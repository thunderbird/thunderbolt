import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { deleteUser, revokeDevice, deleteEnvelope } from '@/dal'
import type { db as DbType } from '@/db/client'
import { Elysia } from 'elysia'

/** Account API routes. All routes require authentication. */
export const createAccountRoutes = (auth: Auth, database: typeof DbType) => {
  return new Elysia({ prefix: '/account' })
    .use(createAuthMacro(auth))
    .post(
      '/devices/:id/revoke',
      async ({ params, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const revoked = await database.transaction(async (tx) => {
          const txDb = tx as unknown as typeof database
          await deleteEnvelope(txDb, params.id, userId)
          const rows = await revokeDevice(txDb, params.id, userId)
          return rows.length > 0
        })
        if (!revoked) {
          set.status = 404
          return { error: 'Device not found' }
        }
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
