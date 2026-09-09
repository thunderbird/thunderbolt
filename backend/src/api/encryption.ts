/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createAuthMacro } from '@/auth/elysia-plugin'

import {
  bridgeDeviceId,
  cliDeviceIdPrefix,
  countActiveDevices,
  getDeviceById,
  linkSessionToDevice,
  registerDevice,
  registerBridgeDevice,
  deleteRevokedBridgeDevice,
  denyDevice,
  markDeviceTrusted,
  setDeviceNodeId,
  getTrustedNodeIds,
  getEnvelopeByDeviceId,
  hasEnvelopesForUser,
  upsertEnvelope,
  getEncryptionMetadata,
  insertEncryptionMetadataIfNotExists,
  isTrustedAppDevice,
  revokeDeviceSessions,
  maxActiveDevicesPerUser,
  withUserDeviceRegistrationLock,
} from '@/dal'
import type { db as DbType, QueryableDatabase } from '@/db/client'
import { BadRequestError, ForbiddenError } from '@/errors/http-errors'
import { hashCanarySecret, verifyCanaryProof, verifyCanaryProofWithMetadata } from '@/lib/canary'
import { Elysia, t } from 'elysia'

class DeviceRegistrationConflictError extends Error {}

type EncryptionRouteDependencies = {
  readonly linkSessionToDevice?: typeof linkSessionToDevice
}

/**
 * Check if the caller is performing a self-recovery.
 * Requires callerDeviceId === deviceId (self-operation) AND valid canary secret.
 */
const checkSelfRecovery = async (
  txDb: QueryableDatabase,
  userId: string,
  callerDeviceId: string,
  deviceId: string,
  canarySecret?: string,
): Promise<boolean> => {
  if (callerDeviceId !== deviceId || !canarySecret) {
    return false
  }
  return verifyCanaryProof(txDb, userId, canarySecret)
}

/**
 * Encryption API routes for device registration, envelope management, and canary.
 * All routes require authentication via session.
 */
export const createEncryptionRoutes = (
  auth: Auth,
  database: typeof DbType,
  { linkSessionToDevice: bindSessionToDevice = linkSessionToDevice }: EncryptionRouteDependencies = {},
) =>
  new Elysia()
    .use(createAuthMacro(auth))
    .post(
      '/devices',
      async ({ body, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const { deviceId, publicKey, mlkemPublicKey, name } = body

        if (deviceId.startsWith(cliDeviceIdPrefix)) {
          set.status = 400
          return { error: 'CLI device IDs must use account registration' }
        }

        const deviceName = name || 'Unknown device'
        try {
          const result = await database.transaction((tx) =>
            withUserDeviceRegistrationLock(tx, userId, async () => {
              const existingDevice = await getDeviceById(tx, deviceId)
              if (existingDevice) {
                if (existingDevice.userId !== userId) {
                  return { kind: 'device-taken' as const }
                }
                if (existingDevice.revokedAt !== null) {
                  return { kind: 'device-revoked' as const }
                }
              } else {
                const activeCount = await countActiveDevices(tx, userId)
                if (activeCount >= maxActiveDevicesPerUser) {
                  return { kind: 'limit-reached' as const }
                }
              }

              const binding = await bindSessionToDevice(tx, session.id, deviceId, userId)
              if (binding.status === 'conflict') {
                return { kind: 'binding-conflict' as const }
              }
              if (binding.status === 'invalid-session') {
                return { kind: 'invalid-session' as const }
              }

              if (existingDevice?.publicKey && existingDevice.trusted) {
                const envelope = await getEnvelopeByDeviceId(tx, deviceId, userId)
                return {
                  kind: 'registered' as const,
                  trusted: true as const,
                  envelope: envelope?.wrappedCk ?? null,
                }
              }

              const registered = await registerDevice(tx, {
                id: deviceId,
                userId,
                name: deviceName,
                publicKey,
                mlkemPublicKey,
              })

              // Roll back the successful bind if another transaction changed the row after our read.
              if (registered.length === 0 || registered[0].userId !== userId) {
                throw new DeviceRegistrationConflictError()
              }

              return { kind: 'registered' as const, trusted: false as const }
            }),
          )

          if (result.kind === 'device-taken') {
            set.status = 409
            return { error: 'Device ID already taken' }
          }
          if (result.kind === 'device-revoked') {
            set.status = 403
            return { error: 'Device has been revoked' }
          }
          if (result.kind === 'limit-reached') {
            set.status = 422
            return { error: 'Device limit reached' }
          }
          if (result.kind === 'binding-conflict') {
            set.status = 409
            return { code: 'SESSION_DEVICE_MISMATCH' }
          }
          if (result.kind === 'invalid-session') {
            set.status = 401
            return { error: 'Unauthorized' }
          }
          return result.trusted ? { trusted: true as const, envelope: result.envelope } : { trusted: false as const }
        } catch (error) {
          if (error instanceof DeviceRegistrationConflictError) {
            const currentDevice = await getDeviceById(database, deviceId)
            if (currentDevice?.userId === userId && currentDevice.revokedAt !== null) {
              set.status = 403
              return { error: 'Device has been revoked' }
            }
            set.status = 409
            return { error: 'Device ID already taken' }
          }
          throw error
        }
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
        if (!device || device.userId !== userId || device.deviceType === 'cli') {
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
          await database.transaction((tx) =>
            withUserDeviceRegistrationLock(tx, userId, async () => {
              const txDb = tx

              const envelopesExist = await hasEnvelopesForUser(txDb, userId)
              const isFirstDeviceBootstrap = !envelopesExist && callerDeviceId === deviceId

              // First device bootstrap requires canary data for recovery to work
              if (isFirstDeviceBootstrap && (!canaryIv || !canaryCtext || !canarySecret)) {
                throw new BadRequestError('First device bootstrap requires canaryIv, canaryCtext, and canarySecret')
              }

              // Defense-in-depth: if encryption metadata already exists, verify canary proof
              // to prevent E2EE state reset even if device revocation protections are bypassed.
              // Checks `existingMetadata` (not `existingMetadata?.canarySecretHash`) for fail-closed
              // behavior: if metadata exists with a null hash, we block rather than silently skip.
              if (isFirstDeviceBootstrap) {
                const existingMetadata = await getEncryptionMetadata(txDb, userId)
                if (existingMetadata) {
                  if (!(await verifyCanaryProofWithMetadata(canarySecret!, existingMetadata.canarySecretHash))) {
                    throw new ForbiddenError(
                      'Invalid canary secret — cannot re-bootstrap with existing encryption metadata',
                    )
                  }
                }
              }

              // Recovery: device is self-storing and provided canary that matches stored metadata.
              // This means the client fetched the canary, verified the recovery key against it,
              // and is now re-bootstrapping with the recovered CK.
              const isSelfRecovery = isFirstDeviceBootstrap
                ? false
                : await checkSelfRecovery(txDb, userId, callerDeviceId, deviceId, canarySecret)

              // Re-check target device inside transaction to close race window
              const targetDevice = await getDeviceById(txDb, deviceId)
              if (!targetDevice || targetDevice.deviceType === 'cli' || targetDevice.revokedAt != null) {
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
                if (!isTrustedAppDevice(callerDevice, userId)) {
                  const callerBelongsToApp =
                    callerDevice !== null && callerDevice.userId === userId && callerDevice.deviceType !== 'cli'
                  throw new ForbiddenError(
                    callerBelongsToApp ? 'Only trusted devices can store envelopes' : 'Caller device not found',
                  )
                }
              }

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

              // Approval-only state transition: cap check + markDeviceTrusted only run when
              // transitioning untrusted → trusted. For re-key (already-trusted devices rotating
              // envelopes), the upsertEnvelope above is the only state change needed. Running
              // markDeviceTrusted on an already-trusted device matches 0 rows (its WHERE requires
              // approvalPending=true) and would falsely throw 'Device has been revoked'.
              if (!targetDevice.trusted) {
                // registerDevice checks the cap, but pending devices don't count toward it. Without
                // this guard, a user could register N+1 pending devices and approve them all,
                // exceeding maxActiveDevicesPerUser.
                const activeCount = await countActiveDevices(txDb, userId)
                if (activeCount >= maxActiveDevicesPerUser) {
                  throw new ForbiddenError('Device limit reached — revoke an existing device first')
                }

                // Mark device as trusted. Check rows returned to detect a concurrent revoke
                // that committed between the in-tx target read above and this UPDATE.
                const updated = await markDeviceTrusted(txDb, deviceId, userId)
                if (updated.length === 0) {
                  throw new ForbiddenError('Device has been revoked')
                }
              }
            }),
          )
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
        if (!device || device.userId !== userId || device.deviceType === 'cli') {
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
        if (!isTrustedAppDevice(callerDevice, userId)) {
          set.status = 403
          return { error: 'Only trusted devices can deny pending devices' }
        }

        // Target must be a pending device belonging to the same user
        const targetDevice = await getDeviceById(database, params.deviceId)
        if (!targetDevice || targetDevice.userId !== userId || targetDevice.deviceType === 'cli') {
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
      '/devices/:deviceId/node-id',
      async ({ params, body, request, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const callerDeviceId = request.headers.get('x-device-id')?.trim()

        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        // Proof-of-CK-possession prevents X-Device-ID spoofing: only a device that holds the
        // Content Key can decrypt the canary and produce this secret. Mirrors the deny route.
        const validProof = await verifyCanaryProof(database, userId, body.canarySecret)
        if (!validProof) {
          set.status = 403
          return { error: 'Invalid canary secret' }
        }

        // Caller must be a trusted device (defense-in-depth: only a trusted app
        // device may attest another device's P2P identity).
        const callerDevice = await getDeviceById(database, callerDeviceId)
        if (!isTrustedAppDevice(callerDevice, userId)) {
          set.status = 403
          return { error: 'Only trusted devices can set a device node ID' }
        }

        const updated = await setDeviceNodeId(database, params.deviceId, userId, body.nodeId)
        if (updated.length === 0) {
          set.status = 404
          return { error: 'Device not found' }
        }

        return { nodeId: body.nodeId }
      },
      {
        auth: true,
        body: t.Object({
          nodeId: t.String({ minLength: 1, maxLength: 2048 }),
          canarySecret: t.String({ maxLength: 500 }),
        }),
      },
    )
    // Self-enroll: a device binds its OWN iroh endpoint identity (node_id) — no canary /
    // Content Key. Proof-of-possession happens at the iroh handshake on connect, so declaring a
    // node_id you can't dial as grants nothing. The caller is pinned to the session's server-set
    // deviceId (from linkSessionToDevice), so it can only write the device its session is bound
    // to — not an arbitrary target the way the canary-gated POST /devices/:deviceId/node-id can.
    // The trust boundary is the account: a live same-account session may declare its own node_id.
    // Device revocation plus the bridge's heartbeat re-check mitigate a rogue session rather than
    // intra-account isolation here.
    .post(
      '/devices/me/node-id',
      async ({ body, request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const callerDeviceId = request.headers.get('x-device-id')?.trim()

        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        // Pin to the session's bound device. A null (never-linked) session.deviceId also fails
        // this, fail-closed. This is the server-side identity — X-Device-ID alone is client-set.
        if (session.deviceId !== callerDeviceId) {
          set.status = 403
          return { error: 'X-Device-ID does not match the authenticated device' }
        }

        const updated = await setDeviceNodeId(database, callerDeviceId, userId, body.nodeId)
        if (updated.length === 0) {
          set.status = 404
          return { error: 'Device not found' }
        }

        return { nodeId: body.nodeId }
      },
      {
        auth: true,
        body: t.Object({
          nodeId: t.String({ minLength: 1, maxLength: 2048 }),
        }),
      },
    )
    // Account allowlist: the trusted, non-revoked node_ids of the caller's account. The
    // bridge fetches this with a bearer, caches it, and auto-allows same-account iroh peers.
    // Scoped to the caller's user_id — never leaks another account's rows.
    .get(
      '/devices/allowlist',
      async ({ user: sessionUser }) => {
        const userId = sessionUser!.id
        const nodeIds = await getTrustedNodeIds(database, userId)
        return { nodeIds }
      },
      { auth: true },
    )
    // Register a BRIDGE device on the caller's account. Adding an ACP/MCP bridge in the
    // app registers it here as a device with server-set `device_type='bridge'` (clients can't set
    // device_type — it's deny-listed from PowerSync upload, so a bridge MUST be created via this
    // route, not raw sync). Inserted trusted + non-revoked because the user deliberately added
    // their own bridge. Scoped to the caller's account (registerBridgeDevice derives the row id
    // from userId, and the `bridge-` id namespace is reserved from client uploads), so it can
    // never write another user's row. node_id here is the bridge's SERVER NodeId; it surfaces in
    // getTrustedNodeIds (the account allowlist), which is intentional and harmless — no peer can
    // dial as the bridge's key without its ed25519 private key, so listing it grants nothing.
    // A revoked bridge is not silently re-added with the same NodeId. Registration reports the
    // tombstone so the caller can remove it explicitly before pairing again.
    .post(
      '/devices/bridge',
      async ({ body, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const name = body.name?.trim() || 'Bridge'
        const result = await database.transaction((tx) =>
          withUserDeviceRegistrationLock(tx, userId, async () => {
            const existingBridge = await getDeviceById(tx, bridgeDeviceId(userId, body.nodeId))
            if (!existingBridge) {
              const activeCount = await countActiveDevices(tx, userId)
              if (activeCount >= maxActiveDevicesPerUser) {
                return { limitReached: true as const }
              }
            }

            const [device] = await registerBridgeDevice(tx, { userId, nodeId: body.nodeId, name })
            if (!device) {
              const tombstone = await getDeviceById(tx, bridgeDeviceId(userId, body.nodeId))
              if (tombstone?.userId === userId && tombstone.revokedAt != null) {
                return { revoked: true as const }
              }
              throw new Error('Bridge device registration returned no device')
            }
            return { device }
          }),
        )

        if ('limitReached' in result) {
          set.status = 422
          return { error: 'Device limit reached' }
        }
        if ('revoked' in result) {
          set.status = 409
          return { error: 'Bridge device revoked' }
        }
        const { device } = result
        return { id: device.id, nodeId: device.nodeId, deviceType: device.deviceType }
      },
      {
        auth: true,
        body: t.Object({
          nodeId: t.String({ minLength: 1, maxLength: 2048 }),
          name: t.Optional(t.String({ maxLength: 100 })),
        }),
      },
    )
    .delete(
      '/devices/:deviceId',
      async ({ params, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const result = await database.transaction(async (tx) => {
          const device = await getDeviceById(tx, params.deviceId)
          if (!device || device.userId !== userId) {
            return { notFound: true as const }
          }
          if (device.deviceType !== 'bridge' || device.revokedAt == null) {
            return { notRemovable: true as const }
          }

          await revokeDeviceSessions(tx, params.deviceId, userId)
          const deleted = await deleteRevokedBridgeDevice(tx, params.deviceId, userId)
          return deleted.length > 0 ? { success: true as const } : { notFound: true as const }
        })

        if ('notFound' in result) {
          set.status = 404
          return { error: 'Device not found' }
        }
        if ('notRemovable' in result) {
          set.status = 409
          return { error: 'Only revoked bridge devices can be removed' }
        }
        return { success: true }
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
        if (!device || device.userId !== userId || device.deviceType === 'cli') {
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
