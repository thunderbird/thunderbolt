/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType, QueryableDatabase } from '@/db/client'
import { devicesTable } from '@/db/schema'
import { and, count, eq, isNotNull, isNull, or } from 'drizzle-orm'
import { createHash } from 'crypto'

/** Deterministic device id for a bridge, derived from (userId, nodeId). Keying the row on this
 * makes re-registration of the same bridge an idempotent upsert on (userId, nodeId) without a
 * dedicated unique constraint, and guarantees one account can never collide with another's id. */
export const bridgeDeviceIdPrefix = 'bridge-'

export const bridgeDeviceId = (userId: string, nodeId: string) =>
  `${bridgeDeviceIdPrefix}${createHash('sha256').update(`${userId}:${nodeId}`).digest('hex')}`

/** Get a device by ID. Returns userId, trusted, approvalPending, publicKey, and revokedAt, or null if not found. */
export const getDeviceById = async (database: QueryableDatabase, deviceId: string) =>
  database
    .select({
      userId: devicesTable.userId,
      trusted: devicesTable.trusted,
      approvalPending: devicesTable.approvalPending,
      publicKey: devicesTable.publicKey,
      revokedAt: devicesTable.revokedAt,
      deviceType: devicesTable.deviceType,
    })
    .from(devicesTable)
    .where(eq(devicesTable.id, deviceId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Upsert a device: insert new or update lastSeen/name for existing. Only updates if userId matches.
 * When `trusted` is passed (E2EE disabled), new devices are inserted as trusted and existing devices are upgraded.
 * `appVersion`, when provided, is persisted on insert and refreshed on update so operators can see
 * which client version each device is running. */
export const upsertDevice = async (
  database: typeof DbType,
  device: {
    id: string
    userId: string
    name: string
    lastSeen: Date
    createdAt: Date
    trusted?: boolean
    appVersion?: string
  },
) =>
  database
    .insert(devicesTable)
    .values({ ...device, trusted: device.trusted ?? false })
    .onConflictDoUpdate({
      target: devicesTable.id,
      set: {
        lastSeen: device.lastSeen,
        name: device.name,
        ...(device.trusted ? { trusted: true, approvalPending: false } : {}),
        ...(device.appVersion ? { appVersion: device.appVersion } : {}),
      },
      setWhere: eq(devicesTable.userId, device.userId),
    })
    .returning()

/** Revoke a device for a specific user. Sets revokedAt timestamp and clears approval state.
 * Also clears the iroh P2P binding (node_id/node_id_attested_at) so the revoked endpoint
 * identity stops syncing and a bridge operator's allowlist entry for it goes stale.
 * Only matches non-revoked devices so re-revoking is a no-op. */
export const revokeDevice = async (database: typeof DbType, deviceId: string, userId: string) =>
  database
    .update(devicesTable)
    .set({ revokedAt: new Date(), trusted: false, approvalPending: false, nodeId: null, nodeIdAttestedAt: null })
    .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId), isNull(devicesTable.revokedAt)))
    .returning()

/** Mark a device as trusted and clear pending state. Called when an envelope is stored for the device.
 * Excludes revoked devices to prevent zombie state from a concurrent revoke transaction.
 * Requires `approvalPending=true` to guard against the deny→approve race: if denyDevice committed
 * first and cleared approvalPending, this UPDATE is a no-op so a denied device cannot be silently
 * trusted (Finding E).
 * Returns updated rows so callers can detect the 0-row case (concurrent revoke or deny commits
 * between the in-tx target read and this UPDATE). */
export const markDeviceTrusted = async (database: typeof DbType, deviceId: string, userId: string) =>
  database
    .update(devicesTable)
    .set({ trusted: true, approvalPending: false })
    .where(
      and(
        eq(devicesTable.id, deviceId),
        eq(devicesTable.userId, userId),
        eq(devicesTable.approvalPending, true),
        isNull(devicesTable.revokedAt),
      ),
    )
    .returning()

/** Count active (trusted, non-revoked) devices for a user.
 * Pending and limbo devices do NOT count toward the device cap (THU-502). */
export const countActiveDevices = async (database: QueryableDatabase, userId: string) => {
  const rows = await database
    .select({ count: count() })
    .from(devicesTable)
    .where(and(eq(devicesTable.userId, userId), eq(devicesTable.trusted, true), isNull(devicesTable.revokedAt)))
  return rows[0]?.count ?? 0
}

/** Deny a pending device by clearing approval_pending, and clear its iroh P2P binding
 * (node_id/node_id_attested_at) so a denied device stops being dialable — mirroring
 * revokeDevice. The trusted=false guard prevents a TOCTOU race from revoking a
 * concurrently-approved device. */
export const denyDevice = async (database: typeof DbType, deviceId: string, userId: string) =>
  database
    .update(devicesTable)
    .set({ approvalPending: false, nodeId: null, nodeIdAttestedAt: null })
    .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId), eq(devicesTable.trusted, false)))
    .returning()

/**
 * Bind a device to an iroh P2P endpoint identity (node_id) and stamp the attestation time.
 * Only matches non-revoked devices that are trusted or still pending approval — a DENIED device
 * (trusted=false, approval_pending=false) is excluded so a denied peer cannot be re-bound after
 * denyDevice cleared its node_id, and a revoked device cannot be re-bound either.
 * Returns updated rows so callers can detect the 0-row (not found / revoked / denied) case.
 */
export const setDeviceNodeId = async (database: typeof DbType, deviceId: string, userId: string, nodeId: string) =>
  database
    .update(devicesTable)
    .set({ nodeId, nodeIdAttestedAt: new Date() })
    .where(
      and(
        eq(devicesTable.id, deviceId),
        eq(devicesTable.userId, userId),
        isNull(devicesTable.revokedAt),
        or(eq(devicesTable.trusted, true), eq(devicesTable.approvalPending, true)),
      ),
    )
    .returning()

/**
 * List the account's iroh allowlist: the endpoint identities (node_id) of every trusted,
 * non-revoked device that has bound one. Scoped to `userId`, so it never returns another
 * account's rows. A headless bridge fetches this (bearer-auth) to auto-allow same-account
 * peers without embedding PowerSync or holding the E2EE Content Key. Denied/pending devices
 * are excluded (only `trusted` rows), as are revoked ones and rows with a null node_id.
 */
export const getTrustedNodeIds = async (database: typeof DbType, userId: string) =>
  database
    .select({ nodeId: devicesTable.nodeId, deviceType: devicesTable.deviceType })
    .from(devicesTable)
    .where(
      and(
        eq(devicesTable.userId, userId),
        eq(devicesTable.trusted, true),
        isNull(devicesTable.revokedAt),
        isNotNull(devicesTable.nodeId),
      ),
    )

/**
 * Register (or idempotently re-register) a BRIDGE device on the caller's account.
 * A bridge is a device with `device_type='bridge'`, keyed by its server NodeId. The user
 * deliberately added their own ACP/MCP bridge, so it is inserted trusted and non-revoked.
 * `device_type` is set here on the server — clients can never set it (it's deny-listed from
 * PowerSync upload). The row id is derived from (userId, nodeId), so re-adding the same bridge
 * upserts the same row instead of duplicating. The `bridge-` id namespace is reserved from client
 * uploads (see powersync.ts), so the conflict is always the caller's own row.
 *
 * A REVOKED bridge is never silently resurrected: `setWhere` requires `revoked_at IS NULL`, so an
 * upsert onto a revoked row updates nothing and `.returning()` is empty — mirroring how a revoked
 * normal device is refused re-registration. Callers treat the empty result as "revoked".
 */
export const registerBridgeDevice = async (
  database: QueryableDatabase,
  bridge: { userId: string; nodeId: string; name: string },
) => {
  const now = new Date()
  const fields = {
    name: bridge.name,
    deviceType: 'bridge' as const,
    trusted: true,
    approvalPending: false,
    nodeId: bridge.nodeId,
    nodeIdAttestedAt: now,
    lastSeen: now,
  }
  return database
    .insert(devicesTable)
    .values({ id: bridgeDeviceId(bridge.userId, bridge.nodeId), userId: bridge.userId, createdAt: now, ...fields })
    .onConflictDoUpdate({
      target: devicesTable.id,
      set: fields,
      setWhere: and(eq(devicesTable.userId, bridge.userId), isNull(devicesTable.revokedAt)),
    })
    .returning()
}

/** Permanently remove a revoked bridge owned by `userId`.
 * Guards all eligibility conditions in the DELETE so callers cannot remove active or normal devices. */
export const deleteRevokedBridgeDevice = async (database: QueryableDatabase, deviceId: string, userId: string) =>
  database
    .delete(devicesTable)
    .where(
      and(
        eq(devicesTable.id, deviceId),
        eq(devicesTable.userId, userId),
        eq(devicesTable.deviceType, 'bridge'),
        isNotNull(devicesTable.revokedAt),
      ),
    )
    .returning()

/**
 * Register a device with a public key for encryption.
 * Used during the encryption setup flow when the FE sends POST /devices.
 * Inserts as untrusted (default); on conflict updates publicKey and lastSeen.
 */
export const registerDevice = async (
  database: typeof DbType,
  device: { id: string; userId: string; name: string; publicKey: string; mlkemPublicKey: string },
) =>
  database
    .insert(devicesTable)
    .values({
      id: device.id,
      userId: device.userId,
      name: device.name,
      publicKey: device.publicKey,
      mlkemPublicKey: device.mlkemPublicKey,
      approvalPending: true,
      createdAt: new Date(),
      lastSeen: new Date(),
    })
    // On conflict: update public keys, reset trusted to false and mark as pending approval
    // (device must go through approval flow again), and update lastSeen. This handles both
    // concurrent re-registration races and pre-encryption devices that were backfilled as
    // trusted without an envelope. Also clear the iroh P2P binding (node_id/node_id_attested_at)
    // so the old endpoint identity stops syncing while keys/trust reset — mirroring revokeDevice.
    .onConflictDoUpdate({
      target: devicesTable.id,
      set: {
        publicKey: device.publicKey,
        mlkemPublicKey: device.mlkemPublicKey,
        trusted: false,
        approvalPending: true,
        nodeId: null,
        nodeIdAttestedAt: null,
        lastSeen: new Date(),
      },
      setWhere: eq(devicesTable.userId, device.userId),
    })
    .returning()
