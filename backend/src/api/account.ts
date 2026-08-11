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
import { ForbiddenError } from '@/errors/http-errors'
import { verifyChallengeProof } from '@/lib/canary'
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
  return (
    new Elysia({ prefix: '/account' })
      .onError(safeErrorHandler)
      .use(createAuthMacro(auth))
      // Revoke a device (A6). Gated by an ECDSA challenge proof (operation
      // 'revoke') when E2EE v2 is active. Pre-E2EE fallback: no encryption
      // metadata — or metadata with a NULL signing_public_key (a v1 leftover
      // whose proof mechanism no longer exists) — allows revoke without proof.
      // The follow-up AK+DEK rotation after a revoke is client-driven via
      // POST /encryption/rotate (F4 orchestrates).
      .post(
        '/devices/:id/revoke',
        async ({ params, body, request, set, user: sessionUser }) => {
          const userId = sessionUser!.id

          const callerDeviceId = request.headers.get('x-device-id')?.trim()
          if (!callerDeviceId) {
            set.status = 400
            return { error: 'X-Device-ID header is required' }
          }

          // Fast-path proof-required check before opening a transaction.
          const metadata = await getEncryptionMetadata(database, userId)
          const proofRequired = metadata?.signingPublicKey != null
          if (proofRequired && !body.proof) {
            set.status = 403
            return { error: 'Challenge proof required for device revocation' }
          }

          try {
            // Same per-user advisory lock as envelope approval and POST /rotate,
            // so a revoke can't race a concurrent rotation.
            await database.transaction(async (tx) => {
              const txDb = tx as unknown as typeof database
              await txDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`)

              if (proofRequired) {
                if (!(await verifyChallengeProof(txDb, userId, body.proof!, 'revoke', callerDeviceId))) {
                  throw new ForbiddenError('Invalid challenge proof')
                }

                // Caller must be a trusted device (defense-in-depth)
                const callerDevice = await getDeviceById(txDb, callerDeviceId)
                if (!callerDevice || callerDevice.userId !== userId || !callerDevice.trusted) {
                  throw new ForbiddenError('Only trusted devices can revoke devices')
                }
              }

              await deleteEnvelope(txDb, params.id, userId)
              const rows = await revokeDevice(txDb, params.id, userId)

              if (rows.length > 0) {
                await revokeDeviceSessions(txDb, params.id, userId)
              }
            })
          } catch (err) {
            if (err instanceof ForbiddenError) {
              set.status = 403
              return { error: err.message }
            }
            throw err
          }
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
  )
}
