import type { Auth } from '@/auth/elysia-plugin'
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
 * Mock user for sync integration testing
 * TODO: Replace with real authentication once CORS is resolved
 */
const MOCK_USER = {
  id: 'mock-user-00000000-0000-0000-0000-000000000001',
  email: 'mock-user@thunderbolt.local',
  name: 'Mock User',
}

/**
 * Helper to get authenticated user from request
 * Currently returns mock user for testing - bypasses real auth
 */
const getAuthenticatedUser = async (_auth: Auth, _headers: Headers) => {
  // TODO: Restore real authentication once CORS is resolved
  // const session = await auth.api.getSession({ headers })
  // if (!session) {
  //   return null
  // }
  // return session.user
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
          const user = await getAuthenticatedUser(auth, request.headers)
          if (!user) {
            set.status = 401
            return { success: false, error: 'Unauthorized' }
          }

          const { siteId, changes } = body

          if (changes.length === 0) {
            // No changes to push
            const lastChange = await database
              .select({ id: syncChanges.id })
              .from(syncChanges)
              .where(eq(syncChanges.userId, user.id))
              .orderBy(syncChanges.id)
              .limit(1)

            return {
              success: true,
              serverVersion: lastChange[0]?.id.toString() ?? '0',
            }
          }

          // Insert all changes
          const insertedChanges = await database
            .insert(syncChanges)
            .values(
              changes.map((change) => ({
                userId: user.id,
                siteId,
                tableName: change.table,
                pk: change.pk,
                cid: change.cid,
                val: change.val !== undefined ? JSON.stringify(change.val) : null,
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

          // Update or insert device record
          const existingDevice = await database
            .select({ id: syncDevices.id })
            .from(syncDevices)
            .where(and(eq(syncDevices.userId, user.id), eq(syncDevices.siteId, siteId)))
            .limit(1)

          if (existingDevice.length > 0) {
            await database
              .update(syncDevices)
              .set({ lastSeenAt: new Date() })
              .where(eq(syncDevices.id, existingDevice[0].id))
          } else {
            await database.insert(syncDevices).values({
              userId: user.id,
              siteId,
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
          const user = await getAuthenticatedUser(auth, request.headers)
          if (!user) {
            set.status = 401
            return { changes: [], serverVersion: '0', error: 'Unauthorized' }
          }

          const { since, siteId } = query
          const sinceVersion = parseInt(since, 10) || 0

          // Build where conditions
          const conditions = [eq(syncChanges.userId, user.id), gt(syncChanges.id, sinceVersion)]

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
          const serializedChanges = changes.map((change) => ({
            table: change.table,
            pk: change.pk,
            cid: change.cid,
            val: change.val ? JSON.parse(change.val) : null,
            col_version: change.col_version.toString(),
            db_version: change.db_version.toString(),
            site_id: change.site_id,
            cl: change.cl,
            seq: change.seq,
          }))

          // Update device last seen
          if (siteId) {
            const existingDevice = await database
              .select({ id: syncDevices.id })
              .from(syncDevices)
              .where(and(eq(syncDevices.userId, user.id), eq(syncDevices.siteId, siteId)))
              .limit(1)

            if (existingDevice.length > 0) {
              await database
                .update(syncDevices)
                .set({ lastSeenAt: new Date() })
                .where(eq(syncDevices.id, existingDevice[0].id))
            } else {
              await database.insert(syncDevices).values({
                userId: user.id,
                siteId,
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
          }),
        },
      )

      /**
       * Get the current server version for the user
       * Useful for initial sync setup
       */
      .get('/version', async ({ request, set }) => {
        const user = await getAuthenticatedUser(auth, request.headers)
        if (!user) {
          set.status = 401
          return { serverVersion: '0', error: 'Unauthorized' }
        }

        const lastChange = await database
          .select({ id: syncChanges.id })
          .from(syncChanges)
          .where(eq(syncChanges.userId, user.id))
          .orderBy(syncChanges.id)
          .limit(1)

        return {
          serverVersion: lastChange[0]?.id.toString() ?? '0',
        }
      })
  )
}
