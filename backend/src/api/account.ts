/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { purgeCloudRunnerData } from '@/cloud-runner/purge'
import { getSettings, type Settings } from '@/config/settings'
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

/** Minimal logger surface these routes use — narrower than Pino so tests can
 *  pass a one-method recorder without dragging in the full type. */
export type AccountLogger = {
  error: (context: Record<string, unknown>, message: string) => void
}

export type AccountRoutesDeps = {
  settings?: Settings
  fetchFn?: typeof fetch
  logger?: AccountLogger
}

/** Account API routes. All routes require authentication. */
export const createAccountRoutes = (auth: Auth, database: typeof DbType, deps: AccountRoutesDeps = {}) => {
  const settings = deps.settings ?? getSettings()
  const fetchFn = deps.fetchFn ?? globalThis.fetch
  const logger = deps.logger

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
      async ({ request, set, user }) => {
        const purgeFailure = await purgeCloudRunnerData({
          settings,
          authorization: request.headers.get('authorization'),
          fetchFn,
        })
        if (purgeFailure) {
          // Deleting the account wins over purging the runner: a runner outage
          // must not leave the user unable to delete, and the runner's retention
          // TTL reclaims whatever this call failed to remove.
          logger?.error({ userId: user.id, reason: purgeFailure }, 'cloud runner purge failed; deleting account anyway')
        }

        // tables have cascade delete on user_id and they will be deleted automatically
        await deleteUser(database, user.id)

        set.status = 204
      },
      { auth: true },
    )
}
