import { type Auth, createAuthMacro } from '@/auth/elysia-plugin'
import {
  countActiveDevices,
  getDeviceById,
  linkSessionToDevice,
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
 * Verify proof-of-CK-possession by comparing SHA-256(canarySecret) against stored hash.
 * Used to gate trust-sensitive operations (device approval, deny) — prevents X-Device-ID spoofing
 * because only a device that possesses the Content Key can decrypt the canary and extract the secret.
 */
const verifyCanaryProof = async (db: typeof DbType, userId: string, canarySecret: string): Promise<boolean> => {
  const metadata = await getEncryptionMetadata(db, userId)
  if (!metadata?.canarySecretHash) return false
  const hash = await hashCanarySecret(canarySecret)
  const hashBuf = Buffer.from(hash)
  const storedBuf = Buffer.from(metadata.canarySecretHash)
  if (hashBuf.length !== storedBuf.length) return false
  return timingSafeEqual(hashBuf, storedBuf)
}

/**
 * Check if the caller is performing a self-recovery.
 * Requires callerDeviceId === deviceId (self-operation) AND valid canary secret.
 */
const checkSelfRecovery = async (
  txDb: typeof DbType,
  userId: string,
  callerDeviceId: string,
  deviceId: string,
  canarySecret?: string,
): Promise<boolean> => {
  if (callerDeviceId !== deviceId || !canarySecret) return false
  return verifyCanaryProof(txDb, userId, canarySecret)
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
      async ({ body, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const { deviceId, publicKey, mlkemPublicKey, name } = body

        // Check if device already exists (fast-path before transaction)
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
              await linkSessionToDevice(database, session.id, deviceId, userId)
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

        // Wrap limit check + registration in a transaction to prevent TOCTOU race
        const deviceName = name || 'Unknown device'
        const result = await database.transaction(async (tx) => {
          const txDb = tx as unknown as typeof database

          // Re-check device inside transaction to close race window
          const freshDevice = await getDeviceById(txDb, deviceId)
          if (!freshDevice) {
            const activeCount = await countActiveDevices(txDb, userId)
            if (activeCount >= 10) return { limitReached: true as const }
          }

          const registered = await registerDevice(txDb, {
            id: deviceId,
            userId,
            name: deviceName,
            publicKey,
            mlkemPublicKey,
          })

          // If upsert returned no rows, another user claimed this device ID
          if (registered.length === 0 || registered[0].userId !== userId) {
            return { taken: true as const }
          }

          return { ok: true as const }
        })

        if ('limitReached' in result) {
          set.status = 422
          return { error: 'Device limit reached' }
        }

        if ('taken' in result) {
          set.status = 409
          return { error: 'Device ID already taken' }
        }

        await linkSessionToDevice(database, session.id, deviceId, userId)
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
              // Proof-of-CK-possession prevents X-Device-ID spoofing: a pending device
              // cannot provide the canary secret because it doesn't have the Content Key.
              if (!canarySecret) {
                throw new ForbiddenError('Canary secret required for device approval')
              }
              if (!(await verifyCanaryProof(txDb, userId, canarySecret))) {
                throw new ForbiddenError('Invalid canary secret')
              }

              // Caller-trust check (defense-in-depth)
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
      async ({ params, body, request, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const callerDeviceId = request.headers.get('x-device-id')?.trim()

        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        // Proof-of-CK-possession prevents X-Device-ID spoofing
        const validProof = await verifyCanaryProof(database, userId, body.canarySecret)
        if (!validProof) {
          set.status = 403
          return { error: 'Invalid canary secret' }
        }

        // Caller must be a trusted device (defense-in-depth)
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
      {
        auth: true,
        body: t.Object({
          canarySecret: t.String({ maxLength: 500 }),
        }),
      },
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
