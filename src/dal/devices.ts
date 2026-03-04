import { desc, eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { devicesTable } from '@/db/tables'

export type Device = {
  id: string
  userId: string
  name: string
  lastSeen: string | null
  createdAt: string | null
  revokedAt: string | null
}

/**
 * Gets a single device by id from the local DB (synced via PowerSync).
 */
export const getDevice = (db: AnyDrizzleDatabase, deviceId: string) => {
  return db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
}

/**
 * Gets all devices for the current user from the local DB (synced via PowerSync).
 */
export const getAllDevices = (db: AnyDrizzleDatabase) => {
  const query = db.select().from(devicesTable).orderBy(desc(devicesTable.lastSeen))

  return query as typeof query & { execute: () => Promise<Device[]> }
}
