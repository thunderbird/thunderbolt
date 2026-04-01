import type { db as DbType } from '@/db/client'
import { devicesTable } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

/** Get a device by ID. Returns userId, trusted, publicKey, and revokedAt, or null if not found. */
export const getDeviceById = async (database: typeof DbType, deviceId: string) =>
  database
    .select({
      userId: devicesTable.userId,
      trusted: devicesTable.trusted,
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

/** Revoke a device for a specific user. Sets revokedAt timestamp. */
export const revokeDevice = async (database: typeof DbType, deviceId: string, userId: string) =>
  database
    .update(devicesTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId)))

/** Mark a device as trusted. Called when an envelope is stored for the device. */
export const markDeviceTrusted = async (database: typeof DbType, deviceId: string, userId: string) =>
  database
    .update(devicesTable)
    .set({ trusted: true })
    .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId)))

/**
 * Register a device with a public key for encryption.
 * Used during the encryption setup flow when the FE sends POST /devices.
 * Inserts as untrusted (default); on conflict updates publicKey and lastSeen.
 */
export const registerDevice = async (
  database: typeof DbType,
  device: { id: string; userId: string; name: string; publicKey: string },
) =>
  database
    .insert(devicesTable)
    .values({
      id: device.id,
      userId: device.userId,
      name: device.name,
      publicKey: device.publicKey,
      createdAt: new Date(),
      lastSeen: new Date(),
    })
    // Defensive: handles concurrent re-registration race. The API handler returns early
    // for existing devices, so this branch rarely executes — it prevents a hard insert failure.
    .onConflictDoUpdate({
      target: devicesTable.id,
      set: { publicKey: device.publicKey, lastSeen: new Date() },
      setWhere: eq(devicesTable.userId, device.userId),
    })
    .returning()
