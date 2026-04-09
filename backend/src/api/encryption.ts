import { type Auth, createAuthMacro } from '@/auth/elysia-plugin'
import {
  getDeviceById,
  registerDevice,
  denyDevice,
  markDeviceTrusted,
  getEnvelopeByDeviceId,
  hasEnvelopesForUser,
  upsertEnvelope,
  getEncryptionMetadata,
  insertEncryptionMetadataIfNotExists,
} from '@/dal'
import type { db as DbType } from '@/db/client'
import { BadRequestError, ForbiddenError } from '@/errors/http-errors'
import { timingSafeEqual } from 'crypto'
import { Elysia, t } from 'elysia'

/** Hash a canary secret using SHA-256. Returns hex-encoded hash. */
const hashCanarySecret = async (secret: string): Promise<string> => {
  const encoded = new TextEncoder().encode(secret)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Check if the caller is performing a self-recovery by verifying proof-of-CK-possession.
 * The client must provide the canary secret (extracted by decrypting the canary with the CK).
 * We verify by comparing SHA-256(canarySecret) against the stored hash.
 */
const checkSelfRecovery = async (
  txDb: typeof DbType,
  userId: string,
  callerDeviceId: string,
  deviceId: string,
  canarySecret?: string,
): Promise<boolean> => {
  if (callerDeviceId !== deviceId || !canarySecret) return false
  const metadata = await getEncryptionMetadata(txDb, userId)
  if (!metadata?.canarySecretHash) return false
  const hash = await hashCanarySecret(canarySecret)
  const hashBuf = Buffer.from(hash)
  const storedBuf = Buffer.from(metadata.canarySecretHash)
  if (hashBuf.length !== storedBuf.length) return false
  return timingSafeEqual(hashBuf, storedBuf)
}

/**
 * Encryption API routes for device registration, envelope management, and canary.
 * All routes require authentication via session.
 */
export const createEncryptionRoutes = (auth: Auth, database: typeof DbType) =>
  new Elysia()
    .use(createAuthMacro(auth))
    .post(
      '/devices',
      async ({ body, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const { deviceId, publicKey, mlkemPublicKey, name } = body

        // Check if device already exists
        const existingDevice = await getDeviceById(database, deviceId)

        if (existingDevice) {
          // Device belongs to a different user
          if (existingDevice.userId !== userId) {
            set.status = 409
            return { error: 'Device ID already taken' }
          }

          // Revoked — device cannot re-register
          if (existingDevice.revokedAt != null) {
            set.status = 403
            return { error: 'Device has been revoked' }
          }

          // Encryption-registered device (has publicKey): return current state
          if (existingDevice.publicKey) {
            if (existingDevice.trusted) {
              const envelope = await getEnvelopeByDeviceId(database, deviceId, userId)
              return {
                trusted: true as const,
                envelope: envelope?.wrappedCk ?? null,
              }
            }
            // Non-trusted device re-registering (reopen modal after deny/cancel):
            // fall through to registerDevice which upserts with approvalPending=true
          }

          // Pre-encryption device (no publicKey): fall through to register with publicKey
        }

        // New device OR pre-encryption device — register with publicKey
        const deviceName = name || 'Unknown device'
        await registerDevice(database, {
          id: deviceId,
          userId,
          name: deviceName,
          publicKey,
          mlkemPublicKey,
        })

        return { trusted: false as const }
      },
      {
        auth: true,
        body: t.Object({
          deviceId: t.String({ maxLength: 36 }),
          publicKey: t.String({ maxLength: 200 }),
          mlkemPublicKey: t.String({ maxLength: 1700 }),
          name: t.Optional(t.String({ maxLength: 100 })),
        }),
      },
    )
    .post(
      '/devices/:deviceId/envelope',
      async ({ params, body, request, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const { deviceId } = params
        const { wrappedCK, canaryIv, canaryCtext, canarySecret } = body

        // Pre-transaction check: fast-path rejection for missing/wrong-user/revoked devices
        // without starting a transaction. Re-checked inside tx to close race window.
        const device = await getDeviceById(database, deviceId)
        if (!device || device.userId !== userId) {
          set.status = 404
          return { error: 'Device not found' }
        }

        if (device.revokedAt != null) {
          set.status = 403
          return { error: 'Device has been revoked' }
        }

        // Reject if target device is already trusted (prevents envelope overwrite attacks)
        // Only the device itself can re-key its own envelope
        const callerDeviceId = request.headers.get('x-device-id')?.trim()
        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        if (device.trusted && callerDeviceId !== deviceId) {
          set.status = 409
          return { error: 'Cannot overwrite envelope of an already-trusted device' }
        }

        // Use a transaction for atomicity (prevents race conditions on first-device bootstrap)
        try {
          await database.transaction(async (tx) => {
            const txDb = tx as unknown as typeof database

            const envelopesExist = await hasEnvelopesForUser(txDb, userId)
            const isFirstDeviceBootstrap = !envelopesExist && callerDeviceId === deviceId

            // First device bootstrap requires canary data for recovery to work
            if (isFirstDeviceBootstrap && (!canaryIv || !canaryCtext || !canarySecret)) {
              throw new BadRequestError('First device bootstrap requires canaryIv, canaryCtext, and canarySecret')
            }

            // Recovery: device is self-storing and provided canary that matches stored metadata.
            // This means the client fetched the canary, verified the recovery key against it,
            // and is now re-bootstrapping with the recovered CK.
            const isSelfRecovery = isFirstDeviceBootstrap
              ? false
              : await checkSelfRecovery(txDb, userId, callerDeviceId, deviceId, canarySecret)

            // Re-check target device inside transaction to close race window
            const targetDevice = await getDeviceById(txDb, deviceId)
            if (!targetDevice || targetDevice.revokedAt != null) {
              throw new ForbiddenError('Device has been revoked')
            }

            if (!isFirstDeviceBootstrap && !isSelfRecovery) {
              const callerDevice = await getDeviceById(txDb, callerDeviceId)
              if (!callerDevice || callerDevice.userId !== userId) {
                throw new ForbiddenError('Caller device not found')
              }
              if (!callerDevice.trusted) {
                throw new ForbiddenError('Only trusted devices can store envelopes')
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
              const canarySecretHash = canarySecret ? await hashCanarySecret(canarySecret) : undefined
              await insertEncryptionMetadataIfNotExists(txDb, {
                userId,
                canaryIv,
                canaryCtext,
                canarySecretHash,
              })
            }

            // Mark device as trusted
            await markDeviceTrusted(txDb, deviceId, userId)
          })
        } catch (err) {
          if (err instanceof BadRequestError) {
            set.status = 400
            return { error: err.message }
          }
          if (err instanceof ForbiddenError) {
            set.status = 403
            return { error: err.message }
          }
          throw err
        }

        return { trusted: true as const }
      },
      {
        auth: true,
        body: t.Object({
          wrappedCK: t.String({ maxLength: 2200 }),
          canaryIv: t.Optional(t.String({ maxLength: 500 })),
          canaryCtext: t.Optional(t.String({ maxLength: 500 })),
          canarySecret: t.Optional(t.String({ maxLength: 500 })),
        }),
      },
    )
    .get(
      '/devices/me/envelope',
      async ({ request, set, user: sessionUser }) => {
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

        if (device.revokedAt != null) {
          set.status = 403
          return { error: 'Device has been revoked' }
        }

        // Device was denied or cancelled — not pending, not trusted, not revoked
        if (!device.approvalPending && !device.trusted) {
          set.status = 422
          return { error: 'Approval not pending' }
        }

        const envelope = await getEnvelopeByDeviceId(database, deviceId, userId)
        if (!envelope) {
          set.status = 404
          return { error: 'Envelope not found' }
        }

        return {
          trusted: device.trusted,
          wrappedCK: envelope.wrappedCk,
        }
      },
      { auth: true },
    )
    .get(
      '/encryption/canary',
      async ({ set, user: sessionUser }) => {
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
      },
      { auth: true },
    )
    .post(
      '/devices/:deviceId/deny',
      async ({ params, request, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const callerDeviceId = request.headers.get('x-device-id')?.trim()

        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        // Caller must be a trusted device
        const callerDevice = await getDeviceById(database, callerDeviceId)
        if (!callerDevice || callerDevice.userId !== userId || !callerDevice.trusted) {
          set.status = 403
          return { error: 'Only trusted devices can deny pending devices' }
        }

        // Target must be a pending device belonging to the same user
        const targetDevice = await getDeviceById(database, params.deviceId)
        if (!targetDevice || targetDevice.userId !== userId) {
          set.status = 404
          return { error: 'Device not found' }
        }

        if (targetDevice.trusted || targetDevice.revokedAt != null) {
          set.status = 409
          return { error: 'Device is not pending approval' }
        }

        const rows = await denyDevice(database, params.deviceId, userId)
        if (rows.length === 0) {
          set.status = 404
          return { error: 'Device not found' }
        }

        set.status = 204
      },
      { auth: true },
    )
    .post(
      '/devices/me/cancel-pending',
      async ({ request, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const deviceId = request.headers.get('x-device-id')?.trim()

        if (!deviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        const device = await getDeviceById(database, deviceId)
        if (!device || device.userId !== userId) {
          set.status = 404
          return { error: 'Device not found' }
        }

        if (device.trusted || device.revokedAt != null) {
          set.status = 409
          return { error: 'Device is not pending approval' }
        }

        await denyDevice(database, deviceId, userId)
        set.status = 204
      },
      { auth: true },
    )
