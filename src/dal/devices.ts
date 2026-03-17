import { desc, eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { devicesTable } from '@/db/tables'
import { getShadowTable, decryptedJoin, decryptedSelectFor } from '@/db/encryption'
import type { DrizzleQueryWithPromise } from '@/types'

export type Device = {
  id: string
  userId: string
  name: string
  lastSeen: string | null
  createdAt: string | null
  revokedAt: string | null
}

const devicesShadow = getShadowTable('devices')
const devicesSelect = decryptedSelectFor('devices')

/**
 * Gets a single device by id from the local DB (synced via PowerSync).
 */
export const getDevice = (db: AnyDrizzleDatabase, deviceId: string) => {
  const query = db
    .select(devicesSelect)
    .from(devicesTable)
    .leftJoin(devicesShadow, decryptedJoin(devicesTable, devicesShadow))
    .where(eq(devicesTable.id, deviceId))
  return query as typeof query & DrizzleQueryWithPromise<Device>
}

/**
 * Gets all devices for the current user from the local DB (synced via PowerSync).
 */
export const getAllDevices = (db: AnyDrizzleDatabase) => {
  const query = db
    .select(devicesSelect)
    .from(devicesTable)
    .leftJoin(devicesShadow, decryptedJoin(devicesTable, devicesShadow))
    .orderBy(desc(devicesTable.lastSeen))
  return query as typeof query & DrizzleQueryWithPromise<Device>
}
