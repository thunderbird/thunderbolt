/**
 * Shared utilities for sync operations
 * Used by both HTTP routes and WebSocket handlers
 */

import { user } from '@/db/auth-schema'
import type { db as DbType } from '@/db/client'
import { and, eq } from 'drizzle-orm'
import { syncDevices } from './schema'

/**
 * Compare two migration versions
 * Migration hashes are in format: 0000_name, 0001_name, etc.
 * Returns: negative if a < b, 0 if equal, positive if a > b
 */
export const compareMigrationVersions = (a: string | null, b: string | null): number => {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1

  // Extract numeric prefix (e.g., "0000" from "0000_nice_mandroid")
  const getVersionNumber = (version: string): number => {
    const match = version.match(/^(\d+)/)
    return match ? parseInt(match[1], 10) : 0
  }

  return getVersionNumber(a) - getVersionNumber(b)
}

/**
 * Get the required migration version for a user
 */
export const getRequiredMigrationVersion = async (database: typeof DbType, userId: string): Promise<string | null> => {
  const currentUser = await database
    .select({ syncMigrationVersion: user.syncMigrationVersion })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)

  return currentUser[0]?.syncMigrationVersion ?? null
}

/**
 * Update the user's sync migration version if the new version is higher
 */
export const updateMigrationVersionIfNewer = async (
  database: typeof DbType,
  userId: string,
  migrationVersion: string | undefined,
  currentVersion: string | null,
): Promise<void> => {
  if (migrationVersion && compareMigrationVersions(migrationVersion, currentVersion) > 0) {
    await database.update(user).set({ syncMigrationVersion: migrationVersion }).where(eq(user.id, userId))
  }
}

/**
 * Upsert a device record (update if exists, insert if not)
 */
export const upsertDevice = async (
  database: typeof DbType,
  userId: string,
  siteId: string,
  migrationVersion: string | undefined,
): Promise<void> => {
  const existingDevice = await database
    .select({ id: syncDevices.id })
    .from(syncDevices)
    .where(and(eq(syncDevices.userId, userId), eq(syncDevices.siteId, siteId)))
    .limit(1)

  if (existingDevice.length > 0) {
    await database
      .update(syncDevices)
      .set({ lastSeenAt: new Date(), migrationVersion })
      .where(eq(syncDevices.id, existingDevice[0].id))
  } else {
    await database.insert(syncDevices).values({
      userId,
      siteId,
      migrationVersion,
      lastSeenAt: new Date(),
    })
  }
}
