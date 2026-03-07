import { desc, eq } from 'drizzle-orm'
import { DatabaseSingleton } from '@/db/singleton'
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
export const getDevice = async (deviceId: string): Promise<Device | null> => {
  const db = DatabaseSingleton.instance.db
  const row = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId)).get()
  return (row ?? null) as Device | null
}

/**
 * Gets all devices for the current user from the local DB (synced via PowerSync).
 */
export const getAllDevices = () => {
  const query = DatabaseSingleton.instance.db.select().from(devicesTable).orderBy(desc(devicesTable.lastSeen))

  return query as typeof query & { execute: () => Promise<Device[]> }
}
