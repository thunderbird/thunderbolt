import type { db as DbType } from '@/db/client'
import { devicesTable } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

/** Get a device by ID. Returns userId, status, and revokedAt, or null if not found. */
export const getDeviceById = async (database: typeof DbType, deviceId: string) =>
  database
    .select({
      userId: devicesTable.userId,
      status: devicesTable.status,
      revokedAt: devicesTable.revokedAt,
    })
    .from(devicesTable)
    .where(eq(devicesTable.id, deviceId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Upsert a device: insert new with APPROVAL_PENDING or update lastSeen/name for existing. Only updates if userId matches. */
export const upsertDevice = async (
  database: typeof DbType,
  device: { id: string; userId: string; name: string; lastSeen: Date; createdAt: Date },
) =>
  database
    .insert(devicesTable)
    .values({ ...device, status: 'APPROVAL_PENDING' })
    .onConflictDoUpdate({
      target: devicesTable.id,
      set: { lastSeen: device.lastSeen, name: device.name },
      setWhere: eq(devicesTable.userId, device.userId),
    })
    .returning()

/** Revoke a device for a specific user. Sets both status and revokedAt. */
export const revokeDevice = async (database: typeof DbType, deviceId: string, userId: string) =>
  database
    .update(devicesTable)
    .set({ status: 'REVOKED', revokedAt: new Date() })
    .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId)))

/** Update a device's status. */
export const updateDeviceStatus = async (
  database: typeof DbType,
  deviceId: string,
  userId: string,
  status: 'APPROVAL_PENDING' | 'TRUSTED' | 'REVOKED',
) =>
  database
    .update(devicesTable)
    .set({ status })
    .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId)))

/**
 * Register a device with APPROVAL_PENDING status and a public key.
 * Used during the encryption setup flow when the FE sends POST /devices.
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
      status: 'APPROVAL_PENDING',
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
