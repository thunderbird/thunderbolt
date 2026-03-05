import type { db as DbType } from '@/db/client'
import { devicesTable } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

/** Get a device by ID. Returns userId and revokedAt, or null if not found. */
export const getDeviceById = async (database: typeof DbType, deviceId: string) =>
  database
    .select({ userId: devicesTable.userId, revokedAt: devicesTable.revokedAt })
    .from(devicesTable)
    .where(eq(devicesTable.id, deviceId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Upsert a device: insert new or update lastSeen/name for existing. Only updates if userId matches. */
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

/** Revoke a device for a specific user. */
export const revokeDevice = async (database: typeof DbType, deviceId: string, userId: string) =>
  database
    .update(devicesTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId)))
