import type { db as DbType } from '@/db/client'
import { devicesTable } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

/** Get a device by ID. Returns userId, trusted, approvalPending, publicKey, and revokedAt, or null if not found. */
export const getDeviceById = async (database: typeof DbType, deviceId: string) =>
  database
    .select({
      userId: devicesTable.userId,
      trusted: devicesTable.trusted,
      approvalPending: devicesTable.approvalPending,
      publicKey: devicesTable.publicKey,
      revokedAt: devicesTable.revokedAt,
    })
    .from(devicesTable)
    .where(eq(devicesTable.id, deviceId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Upsert a device: insert new (untrusted) or update lastSeen/name for existing. Only updates if userId matches. */
export const upsertDevice = async (
  database: typeof DbType,
  device: { id: string; userId: string; name: string; lastSeen: Date; createdAt: Date },
) =>
  database
    .insert(devicesTable)
    .values(device)
    .onConflictDoUpdate({
      target: devicesTable.id,
      set: { lastSeen: device.lastSeen, name: device.name },
      setWhere: eq(devicesTable.userId, device.userId),
    })
    .returning()

/** Revoke a device for a specific user. Sets revokedAt timestamp and clears approval state. */
export const revokeDevice = async (database: typeof DbType, deviceId: string, userId: string) =>
  database
    .update(devicesTable)
    .set({ revokedAt: new Date(), trusted: false, approvalPending: false })
    .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId)))
    .returning()

/** Mark a device as trusted and clear pending state. Called when an envelope is stored for the device. */
export const markDeviceTrusted = async (database: typeof DbType, deviceId: string, userId: string) =>
  database
    .update(devicesTable)
    .set({ trusted: true, approvalPending: false })
    .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId)))

/** Deny a pending device by clearing its approval_pending flag. Does not revoke. */
export const denyDevice = async (database: typeof DbType, deviceId: string, userId: string) =>
  database
    .update(devicesTable)
    .set({ approvalPending: false })
    .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId)))
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
    // trusted without an envelope.
    .onConflictDoUpdate({
      target: devicesTable.id,
      set: {
        publicKey: device.publicKey,
        mlkemPublicKey: device.mlkemPublicKey,
        trusted: false,
        approvalPending: true,
        lastSeen: new Date(),
      },
      setWhere: eq(devicesTable.userId, device.userId),
    })
    .returning()
