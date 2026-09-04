/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { verifySignedBearerToken } from '@/auth/bearer-token'
import type { Settings } from '@/config/settings'
import {
  countActiveDevices,
  deleteUser,
  revokeDevice,
  deleteEnvelope,
  revokeDeviceSessions,
  getActivePersistedSession,
  getDeviceById,
  getEncryptionMetadata,
  isCliDeviceId,
  isTrustedAppDevice,
  maxActiveDevicesPerUser,
  upsertCliDevice,
  withUserDeviceRegistrationLock,
} from '@/dal'
import { user as userTable } from '@/db/auth-schema'
import type { db as DbType, QueryableDatabase } from '@/db/client'
import { cliRegistrationPendingDeviceId, linkCliSessionToDevice } from '@/dal/sessions'
import { verifyCanaryProofWithMetadata } from '@/lib/canary'
import { safeErrorHandler } from '@/middleware/error-handling'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

class SessionDeviceBindingConflictError extends Error {}
class PersistedSessionInvalidError extends Error {}

type AccountRouteDependencies = {
  linkCliSessionToDevice?: typeof linkCliSessionToDevice
}

/** Extract and verify the raw Better Auth token from a signed Authorization bearer. */
const getRawSignedBearerToken = (request: Request, secret: string): string | null => {
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return null
  }
  const signedBearer = authorization.slice('Bearer '.length).trim()
  return signedBearer ? verifySignedBearerToken(signedBearer, secret) : null
}

/** Resolve a real, unexpired, non-anonymous session for the expected account. */
const getNonAnonymousPersistedSession = async (
  database: QueryableDatabase,
  rawToken: string,
  expectedUserId: string,
) => {
  const persistedSession = await getActivePersistedSession(database, rawToken)
  if (!persistedSession || persistedSession.userId !== expectedUserId) {
    return null
  }

  const persistedUsers = await database
    .select({ isAnonymous: userTable.isAnonymous })
    .from(userTable)
    .where(eq(userTable.id, persistedSession.userId))
    .limit(1)
  const persistedUser = persistedUsers[0] ?? null
  return persistedUser && !persistedUser.isAnonymous ? persistedSession : null
}

/** Account API routes. CLI routes verify signed persisted sessions directly. */
export const createAccountRoutes = (
  auth: Auth,
  settings: Settings,
  database: typeof DbType,
  { linkCliSessionToDevice: bindSessionToDevice = linkCliSessionToDevice }: AccountRouteDependencies = {},
) => {
  const { betterAuthSecret, cliDeviceRegistrationEnabled } = settings

  return new Elysia({ prefix: '/account' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .put('/devices/cli', async ({ request, set }) => {
      if (!cliDeviceRegistrationEnabled) {
        set.status = 404
        return { error: 'Not Found' }
      }

      const rawToken = getRawSignedBearerToken(request, betterAuthSecret)
      if (!rawToken) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const initialSession = await getActivePersistedSession(database, rawToken)
      if (!initialSession) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const deviceId = request.headers.get('x-device-id')?.trim()
      if (!deviceId || !isCliDeviceId(deviceId)) {
        set.status = 400
        return { code: 'INVALID_DEVICE_ID' }
      }

      const deviceName = request.headers.get('x-device-name')?.trim()
      if (!deviceName || deviceName.length > 100) {
        set.status = 400
        return { code: 'INVALID_DEVICE_NAME' }
      }

      const appVersion = request.headers.get('x-app-version')?.trim()
      if (!appVersion || appVersion.length > 64) {
        set.status = 400
        return { code: 'INVALID_APP_VERSION' }
      }

      try {
        const result = await database.transaction((tx) =>
          withUserDeviceRegistrationLock(tx, initialSession.userId, async () => {
            const txDb = tx
            const userId = initialSession.userId

            const persistedSession = await getNonAnonymousPersistedSession(txDb, rawToken, initialSession.userId)
            if (!persistedSession) {
              return { ok: false as const, status: 401 as const, body: { error: 'Unauthorized' as const } }
            }

            if (
              persistedSession.deviceId !== null &&
              persistedSession.deviceId !== cliRegistrationPendingDeviceId &&
              persistedSession.deviceId !== deviceId
            ) {
              return {
                ok: false as const,
                status: 409 as const,
                body: { code: 'SESSION_DEVICE_MISMATCH' as const },
              }
            }

            const existingDevice = await getDeviceById(txDb, deviceId)
            if (existingDevice) {
              if (existingDevice.userId !== userId || existingDevice.deviceType !== 'cli') {
                return { ok: false as const, status: 409 as const, body: { code: 'DEVICE_ID_TAKEN' as const } }
              }
              if (existingDevice.revokedAt !== null) {
                return {
                  ok: false as const,
                  status: 403 as const,
                  body: { code: 'DEVICE_DISCONNECTED' as const },
                }
              }
            } else {
              const activeDeviceCount = await countActiveDevices(txDb, userId)
              if (activeDeviceCount >= maxActiveDevicesPerUser) {
                return {
                  ok: false as const,
                  status: 422 as const,
                  body: { code: 'DEVICE_LIMIT_REACHED' as const },
                }
              }
            }

            const now = new Date()
            const upserted = await upsertCliDevice(txDb, {
              id: deviceId,
              userId,
              name: deviceName,
              createdAt: now,
              lastSeen: now,
              appVersion,
            })
            if (upserted.length === 0) {
              const collision = await getDeviceById(txDb, deviceId)
              if (collision?.userId === userId && collision.deviceType === 'cli' && collision.revokedAt !== null) {
                return {
                  ok: false as const,
                  status: 403 as const,
                  body: { code: 'DEVICE_DISCONNECTED' as const },
                }
              }
              return { ok: false as const, status: 409 as const, body: { code: 'DEVICE_ID_TAKEN' as const } }
            }

            const binding = await bindSessionToDevice(txDb, persistedSession.id, deviceId, userId)
            if (binding.status === 'conflict') {
              throw new SessionDeviceBindingConflictError()
            }
            if (binding.status === 'invalid-session') {
              throw new PersistedSessionInvalidError()
            }

            return { ok: true as const }
          }),
        )

        if (!result.ok) {
          set.status = result.status
          return result.body
        }
      } catch (error) {
        if (error instanceof SessionDeviceBindingConflictError) {
          set.status = 409
          return { code: 'SESSION_DEVICE_MISMATCH' }
        }
        if (error instanceof PersistedSessionInvalidError) {
          set.status = 401
          return { error: 'Unauthorized' }
        }
        throw error
      }

      return { deviceId, state: 'registered' as const }
    })
    .post('/devices/cli/logout', async ({ request, set }) => {
      const rawToken = getRawSignedBearerToken(request, betterAuthSecret)
      if (!rawToken) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const initialSession = await getActivePersistedSession(database, rawToken)
      if (!initialSession) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const result = await database.transaction((tx) =>
        withUserDeviceRegistrationLock(tx, initialSession.userId, async () => {
          const txDb = tx
          const userId = initialSession.userId

          const persistedSession = await getNonAnonymousPersistedSession(txDb, rawToken, initialSession.userId)
          if (!persistedSession) {
            return { ok: false as const, status: 401 as const, body: { error: 'Unauthorized' as const } }
          }

          if (!persistedSession.deviceId) {
            return { ok: false as const, status: 409 as const, body: { code: 'CLI_DEVICE_NOT_BOUND' as const } }
          }

          const device = await getDeviceById(txDb, persistedSession.deviceId)
          if (!device || device.userId !== userId || device.deviceType !== 'cli') {
            return { ok: false as const, status: 409 as const, body: { code: 'CLI_DEVICE_NOT_BOUND' as const } }
          }

          await revokeDevice(txDb, persistedSession.deviceId, userId)
          await revokeDeviceSessions(txDb, persistedSession.deviceId, userId)
          return { ok: true as const }
        }),
      )

      if (!result.ok) {
        set.status = result.status
        return result.body
      }

      set.status = 204
    })
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

          // Caller must be a trusted normal device (defense-in-depth)
          const callerDevice = await getDeviceById(database, callerDeviceId)
          if (
            !isTrustedAppDevice(callerDevice, userId) ||
            callerDevice.deviceType !== 'normal' ||
            callerDevice.revokedAt !== null
          ) {
            set.status = 403
            return { error: 'Only trusted devices can revoke devices' }
          }
        }

        await database.transaction((tx) =>
          withUserDeviceRegistrationLock(tx, userId, async () => {
            await deleteEnvelope(tx, params.id, userId)
            const rows = await revokeDevice(tx, params.id, userId)

            if (rows.length > 0) {
              await revokeDeviceSessions(tx, params.id, userId)
            }
          }),
        )
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
