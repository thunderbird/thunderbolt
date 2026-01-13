/**
 * Shared utilities for sync routes and WebSocket handlers
 */

import type { Auth } from '@/auth/elysia-plugin'
import { user } from '@/db/auth-schema'
import type { db as DbType } from '@/db/client'
import { syncChanges, syncDevices } from '@/db/sync-schema'
import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm'
import { t } from 'elysia'

/**
 * Serialized change format for network transport
 */
export type SerializedChange = {
  table: string
  pk: string // base64 encoded
  cid: string
  val: unknown
  col_version: string // bigint as string
  db_version: string // bigint as string
  site_id: string // base64 encoded
  cl: number
  seq: number
}

/**
 * Elysia schema for serialized change validation
 */
export const serializedChangeSchema = t.Object({
  table: t.String(),
  pk: t.String(),
  cid: t.String(),
  val: t.Unknown(),
  col_version: t.String(),
  db_version: t.String(),
  site_id: t.String(),
  cl: t.Number(),
  seq: t.Number(),
})

/**
 * Mock user for sync integration testing
 * TODO: Replace with real authentication once CORS is resolved
 */
export const MOCK_USER = {
  id: 'mock-user-00000000-0000-0000-0000-000000000001',
  email: 'mock-user@thunderbolt.local',
  name: 'Mock User',
} as const

export type AuthenticatedUser = {
  id: string
  email: string
  name: string
}

/**
 * Compare two migration versions
 * Migration hashes are in format: 0000_name, 0001_name, etc.
 * Returns: negative if a < b, 0 if equal, positive if a > b
 */
export const compareMigrationVersions = (a: string | null, b: string | null): number => {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1

  const getVersionNumber = (version: string): number => {
    const match = version.match(/^(\d+)/)
    return match ? parseInt(match[1], 10) : 0
  }

  return getVersionNumber(a) - getVersionNumber(b)
}

/**
 * Ensure mock user exists in database (for development/testing)
 */
export const ensureMockUserExists = async (database: typeof DbType) => {
  const existing = await database.select({ id: user.id }).from(user).where(eq(user.id, MOCK_USER.id)).limit(1)

  if (existing.length === 0) {
    await database.insert(user).values({
      id: MOCK_USER.id,
      email: MOCK_USER.email,
      name: MOCK_USER.name,
      emailVerified: true,
    })
  }
}

/**
 * Get authenticated user from request
 * Currently returns mock user for testing - bypasses real auth
 */
export const getAuthenticatedUser = async (
  database: typeof DbType,
  _auth: Auth,
  _headers: Headers,
): Promise<AuthenticatedUser> => {
  // TODO: Restore real authentication once CORS is resolved
  // const session = await auth.api.getSession({ headers })
  // if (!session) {
  //   return null
  // }
  // return session.user

  await ensureMockUserExists(database)
  return MOCK_USER
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
 * Check if client migration version is valid
 * Returns the required version if upgrade is needed, null otherwise
 */
export const checkMigrationVersionRequirement = async (
  database: typeof DbType,
  userId: string,
  clientVersion: string | undefined,
): Promise<{ needsUpgrade: boolean; requiredVersion: string | null }> => {
  const requiredVersion = await getRequiredMigrationVersion(database, userId)

  if (requiredVersion && compareMigrationVersions(clientVersion ?? null, requiredVersion) < 0) {
    return { needsUpgrade: true, requiredVersion }
  }

  return { needsUpgrade: false, requiredVersion }
}

/**
 * Atomically update migration version if the new version is newer than the current database value.
 * Uses compare-and-set in the WHERE clause to prevent TOCTOU race conditions.
 * Since migration versions are zero-padded (e.g., 0001_name, 0002_name),
 * lexicographic string comparison in SQL works correctly.
 */
export const updateMigrationVersionIfNewer = async (
  database: typeof DbType,
  userId: string,
  newVersion: string | undefined,
) => {
  if (!newVersion) return

  // Atomic compare-and-set: only update if new version is actually newer than current DB value
  await database
    .update(user)
    .set({ syncMigrationVersion: newVersion })
    .where(and(eq(user.id, userId), or(isNull(user.syncMigrationVersion), lt(user.syncMigrationVersion, newVersion))))
}

/**
 * Upsert a sync device record
 */
export const upsertSyncDevice = async (
  database: typeof DbType,
  userId: string,
  siteId: string,
  migrationVersion: string | undefined,
) => {
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

/**
 * Get the latest server version for a user
 */
export const getLatestServerVersion = async (database: typeof DbType, userId: string): Promise<number> => {
  const lastChange = await database
    .select({ id: syncChanges.id })
    .from(syncChanges)
    .where(eq(syncChanges.userId, userId))
    .orderBy(desc(syncChanges.id))
    .limit(1)

  return lastChange[0]?.id ?? 0
}

/**
 * Insert changes into the sync_changes table
 */
export const insertChanges = async (
  database: typeof DbType,
  userId: string,
  siteId: string,
  changes: SerializedChange[],
) => {
  return database
    .insert(syncChanges)
    .values(
      changes.map((change) => ({
        userId,
        siteId,
        tableName: change.table,
        pk: change.pk,
        cid: change.cid,
        val: change.val !== null && change.val !== undefined ? String(change.val) : null,
        colVersion: BigInt(change.col_version),
        dbVersion: BigInt(change.db_version),
        cl: change.cl,
        seq: change.seq,
        siteIdRaw: change.site_id,
      })),
    )
    .returning()
}

/**
 * Raw change format from database query
 */
type RawChange = {
  table: string
  pk: string
  cid: string
  val: string | null
  col_version: bigint
  db_version: bigint
  site_id: string
  cl: number
  seq: number
  id: number
}

/**
 * Fetch changes since a given version
 */
export const fetchChangesSince = async (
  database: typeof DbType,
  userId: string,
  sinceVersion: number,
  limit = 1000,
): Promise<RawChange[]> => {
  return database
    .select({
      table: syncChanges.tableName,
      pk: syncChanges.pk,
      cid: syncChanges.cid,
      val: syncChanges.val,
      col_version: syncChanges.colVersion,
      db_version: syncChanges.dbVersion,
      site_id: syncChanges.siteIdRaw,
      cl: syncChanges.cl,
      seq: syncChanges.seq,
      id: syncChanges.id,
    })
    .from(syncChanges)
    .where(and(eq(syncChanges.userId, userId), gt(syncChanges.id, sinceVersion)))
    .orderBy(syncChanges.id)
    .limit(limit)
}

/**
 * Serialize raw changes for network transport
 */
export const serializeChanges = (changes: RawChange[]): SerializedChange[] => {
  return changes.map((change) => ({
    table: change.table,
    pk: change.pk,
    cid: change.cid,
    val: change.val,
    col_version: change.col_version.toString(),
    db_version: change.db_version.toString(),
    site_id: change.site_id,
    cl: change.cl,
    seq: change.seq,
  }))
}

/**
 * Get max server version from a list of changes
 */
export const getMaxServerVersion = (changes: { id: number }[], fallback: number): number => {
  return changes.length > 0 ? Math.max(...changes.map((c) => c.id)) : fallback
}
