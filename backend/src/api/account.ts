/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
import { verifyChallengeSignature } from '@/lib/canary'
import { safeErrorHandler } from '@/middleware/error-handling'
import { challengeOperations } from '@shared/e2ee-types'
import { sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

/** Elysia schema for the shared ChallengeProof request DTO. */
const proofSchema = t.Object({
  signature: t.String({ maxLength: 200 }),
  nonce: t.String({ maxLength: 128 }),
  operation: t.Union(challengeOperations.map((op) => t.Literal(op))),
  deviceId: t.String({ maxLength: 36 }),
})

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

        // If E2EE is active (encryption metadata exists), require a 'revoke'
        // challenge signature. Checks `metadata` (not the signing key) for
        // fail-closed behavior: a pre-flip v1 account (NULL signing key) fails
        // verification closed and must upgrade before it can revoke. The
        // client-side double-rotation (revoke access + rotate AK/DEK) runs the
        // /rotate call separately; both take the same advisory lock below so they
        // cannot interleave.
        const metadata = await getEncryptionMetadata(database, userId)
        if (metadata) {
          if (!body.proof) {
            set.status = 403
            return { error: 'Challenge proof required for device revocation' }
          }
          if (!(await verifyChallengeSignature(database, userId, body.proof, 'revoke', callerDeviceId))) {
            set.status = 403
            return { error: 'Invalid challenge proof' }
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
          // Same per-user lock as /rotate and /upgrade so the double-rotation
          // (revoke → rotate) can't race an in-flight rotation.
          await txDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`)
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
          proof: t.Optional(proofSchema),
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
