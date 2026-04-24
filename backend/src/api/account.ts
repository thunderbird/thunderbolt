import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import {
  deleteUser,
  revokeDevice,
  deleteEnvelope,
  revokeDeviceSessions,
  getDeviceById,
  getEncryptionMetadata,
} from '@/dal'
import type { db as DbType } from '@/db/client'
import { verifyCanaryProofWithMetadata } from '@/lib/canary'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'

/** Account API routes. All routes require authentication. */
export const createAccountRoutes = (auth: Auth, database: typeof DbType) => {
  return new Elysia({ prefix: '/account' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .post(
      '/devices/:id/revoke',
      async ({ params, body, request, set, user: sessionUser }) => {
        const userId = sessionUser!.id

        const callerDeviceId = request.headers.get('x-device-id')?.trim()
        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        // If E2EE is active (encryption metadata exists), require canary proof-of-CK-possession.
        // Checks `metadata` (not `metadata?.canarySecretHash`) for fail-closed behavior:
        // if metadata exists with a null hash, we still block rather than silently skip.
        const metadata = await getEncryptionMetadata(database, userId)
        if (metadata) {
          if (!body.canarySecret) {
            set.status = 403
            return { error: 'Canary secret required for device revocation' }
          }
          if (!(await verifyCanaryProofWithMetadata(body.canarySecret, metadata.canarySecretHash))) {
            set.status = 403
            return { error: 'Invalid canary secret' }
          }

          // Caller must be a trusted device (defense-in-depth)
          const callerDevice = await getDeviceById(database, callerDeviceId)
          if (!callerDevice || callerDevice.userId !== userId || !callerDevice.trusted) {
            set.status = 403
            return { error: 'Only trusted devices can revoke devices' }
          }
        }

        await database.transaction(async (tx) => {
          const txDb = tx as unknown as typeof database
          await deleteEnvelope(txDb, params.id, userId)
          const rows = await revokeDevice(txDb, params.id, userId)

          if (rows.length > 0) {
            await revokeDeviceSessions(txDb, params.id, userId)
          }
        })
        set.status = 204
      },
      {
        auth: true,
        body: t.Object({
          canarySecret: t.Optional(t.String({ maxLength: 500 })),
        }),
      },
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
