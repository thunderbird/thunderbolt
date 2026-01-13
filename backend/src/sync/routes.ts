import type { Auth } from '@/auth/elysia-plugin'
import type { db as DbType } from '@/db/client'
import { Elysia, t } from 'elysia'
import {
  checkMigrationVersionRequirement,
  fetchChangesSince,
  getAuthenticatedUser,
  getLatestServerVersion,
  getMaxServerVersion,
  insertChanges,
  serializedChangeSchema,
  serializeChanges,
  updateMigrationVersionIfNewer,
  upsertSyncDevice,
} from './shared'

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
          const { needsUpgrade, requiredVersion } = await checkMigrationVersionRequirement(
            database,
            authUser.id,
            migrationVersion,
          )

          if (needsUpgrade) {
            return {
              success: false,
              needsUpgrade: true,
              requiredVersion,
              serverVersion: '0',
            }
          }

          if (changes.length === 0) {
            const serverVersion = await getLatestServerVersion(database, authUser.id)
            return {
              success: true,
              serverVersion: serverVersion.toString(),
            }
          }

          // Atomically update migration version BEFORE inserting changes
          await updateMigrationVersionIfNewer(database, authUser.id, migrationVersion)

          // Insert all changes
          const insertedChanges = await insertChanges(database, authUser.id, siteId, changes)
          const maxServerVersion = getMaxServerVersion(insertedChanges, 0)

          // Update device record
          await upsertSyncDevice(database, authUser.id, siteId, migrationVersion)

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
          const { needsUpgrade, requiredVersion } = await checkMigrationVersionRequirement(
            database,
            authUser.id,
            migrationVersion,
          )

          if (needsUpgrade) {
            return {
              changes: [],
              serverVersion: sinceVersion.toString(),
              needsUpgrade: true,
              requiredVersion,
            }
          }

          // Fetch changes since the given version
          const changes = await fetchChangesSince(database, authUser.id, sinceVersion)
          const maxServerVersion = getMaxServerVersion(changes, sinceVersion)

          // Update device record if siteId is provided
          if (siteId) {
            await upsertSyncDevice(database, authUser.id, siteId, migrationVersion)
          }

          return {
            changes: serializeChanges(changes),
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

        const serverVersion = await getLatestServerVersion(database, authUser.id)
        return {
          serverVersion: serverVersion.toString(),
        }
      })
  )
}
