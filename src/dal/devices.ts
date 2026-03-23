import { desc, eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { devicesTable } from '@/db/tables'
import type { DrizzleQueryWithPromise } from '@/types'

export type DeviceStatus = 'APPROVAL_PENDING' | 'TRUSTED' | 'REVOKED'

export type Device = {
  id: string
  userId: string
  name: string
  status: DeviceStatus | null
  publicKey: string | null
  lastSeen: string | null
  createdAt: string | null
  revokedAt: string | null
}

/**
 * Gets a single device by id from the local DB (synced via PowerSync).
 */
export const getDevice = (db: AnyDrizzleDatabase, deviceId: string) => {
  const query = db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
  return query as typeof query & DrizzleQueryWithPromise<Device>
}

/**
 * Gets all devices for the current user from the local DB (synced via PowerSync).
 */
export const getAllDevices = (db: AnyDrizzleDatabase) => {
  const query = db.select().from(devicesTable).orderBy(desc(devicesTable.lastSeen))
  return query as typeof query & DrizzleQueryWithPromise<Device>
}

/**
 * Gets devices with APPROVAL_PENDING status (synced via PowerSync).
 */
export const getPendingDevices = (db: AnyDrizzleDatabase) => {
  const query = db
    .select()
    .from(devicesTable)
    .where(eq(devicesTable.status, 'APPROVAL_PENDING'))
    .orderBy(desc(devicesTable.createdAt))
  return query as typeof query & DrizzleQueryWithPromise<Device>
}
