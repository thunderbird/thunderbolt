import type { Auth } from '@/auth/elysia-plugin'
import { user } from '@/db/auth-schema'
import type { db as DbType } from '@/db/client'
import { and, eq, gt } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { syncChanges, syncDevices } from './schema'

/**
 * Serialized change format for network transport
 */
const serializedChangeSchema = t.Object({
  table: t.String(),
  pk: t.String(), // base64 encoded
  cid: t.String(),
  val: t.Unknown(),
  col_version: t.String(), // bigint as string
  db_version: t.String(), // bigint as string
  site_id: t.String(), // base64 encoded
  cl: t.Number(),
  seq: t.Number(),
})

/**
 * Compare two migration versions
 * Migration hashes are in format: 0000_name, 0001_name, etc.
 * Returns: negative if a < b, 0 if equal, positive if a > b
 */
const compareMigrationVersions = (a: string | null, b: string | null): number => {
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
 * Mock user for sync integration testing
 * TODO: Replace with real authentication once CORS is resolved
 */
const MOCK_USER = {
  id: 'mock-user-00000000-0000-0000-0000-000000000001',
  email: 'mock-user@thunderbolt.local',
  name: 'Mock User',
}

/**
 * Ensure mock user exists in database (for development/testing)
 */
const ensureMockUserExists = async (database: typeof DbType) => {
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
 * Helper to get authenticated user from request
 * Currently returns mock user for testing - bypasses real auth
 */
const getAuthenticatedUser = async (database: typeof DbType, _auth: Auth, _headers: Headers) => {
  // TODO: Restore real authentication once CORS is resolved
  // const session = await auth.api.getSession({ headers })
  // if (!session) {
  //   return null
  // }
  // return session.user

  // Ensure mock user exists for development
  await ensureMockUserExists(database)
  return MOCK_USER
}

/**
 * Create sync routes for multi-device database synchronization
 */
export const createSyncRoutes = (database: typeof DbType, auth: Auth) => {
  return (
    new Elysia({ prefix: '/sync' })
      .onError(({ code, error, set }) => {
        set.status = code === 'VALIDATION' ? 400 : 500
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      })

      /**
       * Push local changes to the server
       * Requires authentication
       */
      .post(
        '/push',
        async ({ body, request, set }) => {
          const authUser = await getAuthenticatedUser(database, auth, request.headers)
          if (!authUser) {
            set.status = 401
            return { success: false, error: 'Unauthorized' }
          }

          const { siteId, changes, migrationVersion } = body

          // Check if client's migration version meets the minimum required version
          // This prevents outdated clients from pushing changes and advancing their serverVersion pointer
          const currentUser = await database
            .select({ syncMigrationVersion: user.syncMigrationVersion })
            .from(user)
            .where(eq(user.id, authUser.id))
            .limit(1)

          const requiredVersion = currentUser[0]?.syncMigrationVersion ?? null

          // If the client's migration version is older than the required version, block push
          if (requiredVersion && compareMigrationVersions(migrationVersion ?? null, requiredVersion) < 0) {
            return {
              success: false,
              needsUpgrade: true,
              requiredVersion,
              serverVersion: '0', // Don't advance the client's pointer
            }
          }

          if (changes.length === 0) {
            // No changes to push
            const lastChange = await database
              .select({ id: syncChanges.id })
              .from(syncChanges)
              .where(eq(syncChanges.userId, authUser.id))
              .orderBy(syncChanges.id)
              .limit(1)

            return {
              success: true,
              serverVersion: lastChange[0]?.id.toString() ?? '0',
            }
          }

          // IMPORTANT: Update syncMigrationVersion BEFORE inserting changes
          // This prevents a race condition where another device could pull the new changes
          // before the migration version is updated, bypassing the version check
          if (migrationVersion) {
            if (compareMigrationVersions(migrationVersion, requiredVersion) > 0) {
              await database
                .update(user)
                .set({ syncMigrationVersion: migrationVersion })
                .where(eq(user.id, authUser.id))
            }
          }

          // Insert all changes
          // Note: val is already JSON-encoded from cr-sqlite, store it as-is
          const insertedChanges = await database
            .insert(syncChanges)
            .values(
              changes.map((change) => ({
                userId: authUser.id,
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

          // Get the max server version from inserted changes
          const maxServerVersion = Math.max(...insertedChanges.map((c) => c.id))

          // Update or insert device record with migration version
          const existingDevice = await database
            .select({ id: syncDevices.id })
            .from(syncDevices)
            .where(and(eq(syncDevices.userId, authUser.id), eq(syncDevices.siteId, siteId)))
            .limit(1)

          if (existingDevice.length > 0) {
            await database
              .update(syncDevices)
              .set({ lastSeenAt: new Date(), migrationVersion })
              .where(eq(syncDevices.id, existingDevice[0].id))
          } else {
            await database.insert(syncDevices).values({
              userId: authUser.id,
              siteId,
              migrationVersion,
              lastSeenAt: new Date(),
            })
          }

          return {
            success: true,
            serverVersion: maxServerVersion.toString(),
          }
        },
        {
          body: t.Object({
            siteId: t.String(),
            changes: t.Array(serializedChangeSchema),
            dbVersion: t.String(),
            migrationVersion: t.Optional(t.String()),
          }),
        },
      )

      /**
       * Pull changes from the server since a given version
       * Requires authentication
       */
      .get(
        '/pull',
        async ({ query, request, set }) => {
          const authUser = await getAuthenticatedUser(database, auth, request.headers)
          if (!authUser) {
            set.status = 401
            return { changes: [], serverVersion: '0', error: 'Unauthorized' }
          }

          const { since, siteId, migrationVersion } = query
          const sinceVersion = parseInt(since, 10) || 0

          // Check if client's migration version meets the minimum required version
          const currentUser = await database
            .select({ syncMigrationVersion: user.syncMigrationVersion })
            .from(user)
            .where(eq(user.id, authUser.id))
            .limit(1)

          const requiredVersion = currentUser[0]?.syncMigrationVersion ?? null

          // If the client's migration version is older than the required version, block sync
          if (requiredVersion && compareMigrationVersions(migrationVersion ?? null, requiredVersion) < 0) {
            return {
              changes: [],
              serverVersion: sinceVersion.toString(),
              needsUpgrade: true,
              requiredVersion,
            }
          }

          // Build where conditions
          const conditions = [eq(syncChanges.userId, authUser.id), gt(syncChanges.id, sinceVersion)]

          // Exclude changes from the requesting device (they already have those)
          if (siteId) {
            // Note: We actually want changes NOT from this site
            // But for simplicity, let's include all changes and let the client filter
          }

          // Get all changes for this user since the given version
          const changes = await database
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
            .where(and(...conditions))
            .orderBy(syncChanges.id)
            .limit(1000) // Limit to prevent huge responses

          // Get the max server version
          const maxServerVersion = changes.length > 0 ? Math.max(...changes.map((c) => c.id)) : sinceVersion

          // Transform to serialized format
          // Note: val is stored as-is (already JSON-encoded from cr-sqlite)
          const serializedChanges = changes.map((change) => ({
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

          // Update device last seen and migration version
          if (siteId) {
            const existingDevice = await database
              .select({ id: syncDevices.id })
              .from(syncDevices)
              .where(and(eq(syncDevices.userId, authUser.id), eq(syncDevices.siteId, siteId)))
              .limit(1)

            if (existingDevice.length > 0) {
              await database
                .update(syncDevices)
                .set({ lastSeenAt: new Date(), migrationVersion })
                .where(eq(syncDevices.id, existingDevice[0].id))
            } else {
              await database.insert(syncDevices).values({
                userId: authUser.id,
                siteId,
                migrationVersion,
                lastSeenAt: new Date(),
              })
            }
          }

          return {
            changes: serializedChanges,
            serverVersion: maxServerVersion.toString(),
          }
        },
        {
          query: t.Object({
            since: t.String(),
            siteId: t.Optional(t.String()),
            migrationVersion: t.Optional(t.String()),
          }),
        },
      )

      /**
       * Get the current server version for the user
       * Useful for initial sync setup
       */
      .get('/version', async ({ request, set }) => {
        const authUser = await getAuthenticatedUser(database, auth, request.headers)
        if (!authUser) {
          set.status = 401
          return { serverVersion: '0', error: 'Unauthorized' }
        }

        const lastChange = await database
          .select({ id: syncChanges.id })
          .from(syncChanges)
          .where(eq(syncChanges.userId, authUser.id))
          .orderBy(syncChanges.id)
          .limit(1)

        return {
          serverVersion: lastChange[0]?.id.toString() ?? '0',
        }
      })
  )
}
