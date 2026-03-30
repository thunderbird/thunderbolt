import type { Auth } from '@/auth/elysia-plugin'
import {
  getDeviceById,
  registerDevice,
  updateDeviceStatus,
  getEnvelopeByDeviceId,
  hasEnvelopesForUser,
  upsertEnvelope,
  getEncryptionMetadata,
  insertEncryptionMetadataIfNotExists,
} from '@/dal'
import type { db as DbType } from '@/db/client'
import { Elysia, t } from 'elysia'

/**
 * Encryption API routes for device registration, envelope management, and canary.
 * All routes require authentication via session.
 */
export const createEncryptionRoutes = (auth: Auth, database: typeof DbType) =>
  new Elysia()
    .derive(async ({ request, set }) => {
      const session = await auth.api.getSession({ headers: request.headers })
      if (!session) {
        set.status = 401
        return { user: null }
      }
      return { user: session.user }
    })
    .onBeforeHandle(({ user: sessionUser, set }) => {
      if (!sessionUser) {
        set.status = 401
        return { error: 'Unauthorized' }
      }
    })
    .post(
      '/devices',
      async ({ body, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const { deviceId, publicKey, name } = body

        // Check if device already exists
        const existingDevice = await getDeviceById(database, deviceId)

        if (existingDevice) {
          // Device belongs to a different user
          if (existingDevice.userId !== userId) {
            set.status = 409
            return { error: 'Device ID already taken' }
          }

          // Already trusted — return envelope
          if (existingDevice.status === 'TRUSTED') {
            const envelope = await getEnvelopeByDeviceId(database, deviceId, userId)
            return {
              status: 'TRUSTED' as const,
              envelope: envelope?.wrappedCk ?? null,
            }
          }

          // Already pending — return status + firstDevice hint
          if (existingDevice.status === 'APPROVAL_PENDING') {
            const envelopesExist = await hasEnvelopesForUser(database, userId)
            return {
              status: 'APPROVAL_PENDING' as const,
              firstDevice: !envelopesExist,
            }
          }

          // Revoked — device cannot re-register
          if (existingDevice.status === 'REVOKED' || existingDevice.revokedAt != null) {
            set.status = 403
            return { error: 'Device has been revoked' }
          }
        }

        // New device — register with APPROVAL_PENDING
        const deviceName = name && name.length > 0 && name.length <= 100 ? name : 'Unknown device'
        await registerDevice(database, {
          id: deviceId,
          userId,
          name: deviceName,
          publicKey,
        })

        const envelopesExist = await hasEnvelopesForUser(database, userId)
        return {
          status: 'APPROVAL_PENDING' as const,
          firstDevice: !envelopesExist,
        }
      },
      {
        body: t.Object({
          deviceId: t.String(),
          publicKey: t.String(),
          name: t.Optional(t.String()),
        }),
      },
    )
    .post(
      '/devices/:deviceId/envelope',
      async ({ params, body, request, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const { deviceId } = params
        const { wrappedCK, canaryIv, canaryCtext } = body

        // Verify the target device exists and belongs to this user
        const device = await getDeviceById(database, deviceId)
        if (!device || device.userId !== userId) {
          set.status = 404
          return { error: 'Device not found' }
        }

        if (device.status === 'REVOKED' || device.revokedAt != null) {
          set.status = 403
          return { error: 'Device has been revoked' }
        }

        // Reject if target device is already TRUSTED (prevents envelope overwrite attacks)
        // Only the device itself can re-key its own envelope
        const callerDeviceId = request.headers.get('x-device-id')?.trim()
        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        if (device.status === 'TRUSTED' && callerDeviceId !== deviceId) {
          set.status = 409
          return { error: 'Cannot overwrite envelope of an already-trusted device' }
        }

        // Use a transaction for atomicity (prevents race conditions on first-device bootstrap)
        try {
          await database.transaction(async (tx) => {
            const txDb = tx as unknown as typeof database

            const envelopesExist = await hasEnvelopesForUser(txDb, userId)
            const isFirstDeviceBootstrap = !envelopesExist && callerDeviceId === deviceId

            // Re-check target device inside transaction to close race window
            const targetDevice = await getDeviceById(txDb, deviceId)
            if (!targetDevice || targetDevice.status === 'REVOKED' || targetDevice.revokedAt != null) {
              throw new Error('FORBIDDEN:Device has been revoked')
            }

            if (!isFirstDeviceBootstrap) {
              const callerDevice = await getDeviceById(txDb, callerDeviceId)
              if (!callerDevice || callerDevice.userId !== userId) {
                throw new Error('FORBIDDEN:Caller device not found')
              }
              if (callerDevice.status !== 'TRUSTED') {
                throw new Error('FORBIDDEN:Only trusted devices can store envelopes')
              }
            }

            // Store envelope
            await upsertEnvelope(txDb, {
              deviceId,
              userId,
              wrappedCk: wrappedCK,
            })

            // Store canary if provided (first device setup — idempotent)
            if (canaryIv && canaryCtext) {
              await insertEncryptionMetadataIfNotExists(txDb, {
                userId,
                canaryIv,
                canaryCtext,
              })
            }

            // Mark device as trusted
            await updateDeviceStatus(txDb, deviceId, userId, 'TRUSTED')
          })
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('FORBIDDEN:')) {
            set.status = 403
            return { error: err.message.slice('FORBIDDEN:'.length) }
          }
          throw err
        }

        return { status: 'TRUSTED' as const }
      },
      {
        body: t.Object({
          wrappedCK: t.String(),
          canaryIv: t.Optional(t.String()),
          canaryCtext: t.Optional(t.String()),
        }),
      },
    )
    .get('/devices/me/envelope', async ({ request, set, user: sessionUser }) => {
      const userId = sessionUser!.id
      const deviceId = request.headers.get('x-device-id')?.trim()

      if (!deviceId) {
        set.status = 400
        return { error: 'X-Device-ID header is required' }
      }

      // Verify device belongs to this user
      const device = await getDeviceById(database, deviceId)
      if (!device || device.userId !== userId) {
        set.status = 404
        return { error: 'Device not found' }
      }

      if (device.status === 'REVOKED' || device.revokedAt != null) {
        set.status = 403
        return { error: 'Device has been revoked' }
      }

      const envelope = await getEnvelopeByDeviceId(database, deviceId, userId)
      if (!envelope) {
        set.status = 404
        return { error: 'Envelope not found' }
      }

      return {
        status: device.status,
        wrappedCK: envelope.wrappedCk,
      }
    })
    .get('/encryption/canary', async ({ set, user: sessionUser }) => {
      const userId = sessionUser!.id

      const metadata = await getEncryptionMetadata(database, userId)
      if (!metadata) {
        set.status = 404
        return { error: 'Encryption not set up' }
      }

      return {
        canaryIv: metadata.canaryIv,
        canaryCtext: metadata.canaryCtext,
      }
    })
