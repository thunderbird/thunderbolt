import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { deleteUser, revokeDevice, deleteEnvelope, getDeviceById, revokeOtherSessions, upsertDevice } from '@/dal'
import type { db as DbType } from '@/db/client'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'

/** Account API routes. All routes require authentication. */
export const createAccountRoutes = (auth: Auth, database: typeof DbType) => {
  return new Elysia({ prefix: '/account' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .post(
      '/devices',
      async ({ body, set, user }) => {
        const deviceId = body.id.trim()
        if (!deviceId) {
          set.status = 400
          return { code: 'DEVICE_ID_REQUIRED' }
        }

        const existing = await getDeviceById(database, deviceId)
        if (existing) {
          if (existing.userId !== user.id) {
            set.status = 409
            return { code: 'DEVICE_ID_TAKEN' }
          }
          if (existing.revokedAt != null) {
            set.status = 403
            return { code: 'DEVICE_DISCONNECTED' }
          }
          return { registered: true }
        }

        const now = new Date()
        const rawName = body.name?.trim()
        const name = rawName && rawName.length > 0 && rawName.length <= 100 ? rawName : 'Unknown device'
        await upsertDevice(database, { id: deviceId, userId: user.id, name, lastSeen: now, createdAt: now })

        set.status = 201
        return { registered: true }
      },
      {
        auth: true,
        body: t.Object({
          id: t.String(),
          name: t.Optional(t.String()),
        }),
      },
    )
    .post(
      '/devices/:id/revoke',
      async ({ params, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const revoked = await database.transaction(async (tx) => {
          const txDb = tx as unknown as typeof database
          await deleteEnvelope(txDb, params.id, userId)
          const rows = await revokeDevice(txDb, params.id, userId)

          if (rows.length > 0) {
            await revokeOtherSessions(database, userId, session.id)
          }

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
