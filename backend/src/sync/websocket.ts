/**
 * WebSocket-based sync for real-time database synchronization
 * Replaces polling with instant push/pull via persistent WebSocket connections
 */

import type { Auth } from '@/auth/elysia-plugin'
import type { db as DbType } from '@/db/client'
import { and, eq, gt } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { syncChanges } from './schema'
import {
  compareMigrationVersions,
  getRequiredMigrationVersion,
  updateMigrationVersionIfNewer,
  upsertDevice,
} from './utils'

/**
 * Serialized change format for network transport
 */
type SerializedChange = {
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
 * WebSocket message types
 */
type WSMessage =
  | {
      type: 'auth'
      siteId: string
      migrationVersion?: string
      token?: string
    }
  | {
      type: 'push'
      changes: SerializedChange[]
      dbVersion: string
    }
  | {
      type: 'pull'
      since: string
    }

type WSResponse =
  | {
      type: 'auth_success'
      serverVersion: string
    }
  | {
      type: 'auth_error'
      error: string
    }
  | {
      type: 'push_success'
      serverVersion: string
    }
  | {
      type: 'push_error'
      error: string
    }
  | {
      type: 'changes'
      changes: SerializedChange[]
      serverVersion: string
    }
  | {
      type: 'version_mismatch'
      requiredVersion: string
    }

/**
 * Connected client info
 */
type ConnectedClient = {
  ws: {
    send: (data: string) => void
    close: () => void
  }
  userId: string
  siteId: string
  migrationVersion?: string
  lastServerVersion: bigint
}

// Store connected clients by userId for broadcasting
const connectedClients = new Map<string, Set<ConnectedClient>>()

/**
 * Broadcast changes to all connected clients of a user except the sender
 */
const broadcastToUser = (userId: string, senderSiteId: string, message: WSResponse) => {
  const clients = connectedClients.get(userId)
  if (!clients) return

  const messageStr = JSON.stringify(message)
  for (const client of clients) {
    if (client.siteId !== senderSiteId) {
      try {
        client.ws.send(messageStr)
      } catch (error) {
        console.error('Failed to send to client:', error)
      }
    }
  }
}

/**
 * Extended WebSocket data for tracking authentication state
 */
type WSData = {
  authenticated: boolean
  client?: ConnectedClient
}

/**
 * Create WebSocket sync routes for real-time database synchronization
 */
export const createSyncWebSocketRoutes = (database: typeof DbType, auth: Auth) => {
  return new Elysia({ prefix: '/sync' }).ws('/ws', {
    body: t.Object({
      type: t.String(),
      siteId: t.Optional(t.String()),
      migrationVersion: t.Optional(t.String()),
      token: t.Optional(t.String()),
      changes: t.Optional(t.Array(t.Any())),
      dbVersion: t.Optional(t.String()),
      since: t.Optional(t.String()),
    }),

    open(ws) {
      // Store connection temporarily - will be associated with user after auth
      const wsData = ws as unknown as { data: WSData }
      wsData.data = { authenticated: false }
    },

    async message(ws, rawMessage) {
      const wsData = ws as unknown as { data: WSData }
      const message = rawMessage as unknown as WSMessage

      try {
        if (message.type === 'auth') {
          const { siteId, migrationVersion, token } = message

          // Validate bearer token from auth message
          if (!token) {
            ws.send(
              JSON.stringify({
                type: 'auth_error',
                error: 'No auth token provided',
              } satisfies WSResponse),
            )
            ws.close()
            return
          }

          // Create headers with bearer token for session validation
          const headers = new Headers({
            Authorization: `Bearer ${token}`,
          })

          const session = await auth.api.getSession({ headers })
          if (!session) {
            ws.send(
              JSON.stringify({
                type: 'auth_error',
                error: 'Not authenticated',
              } satisfies WSResponse),
            )
            ws.close()
            return
          }

          const authUser = session.user

          // Check migration version
          const requiredVersion = await getRequiredMigrationVersion(database, authUser.id)

          if (requiredVersion && compareMigrationVersions(migrationVersion ?? null, requiredVersion) < 0) {
            ws.send(
              JSON.stringify({
                type: 'version_mismatch',
                requiredVersion,
              } satisfies WSResponse),
            )
            ws.close()
            return
          }

          // Get or create device record
          await upsertDevice(database, authUser.id, siteId, migrationVersion)

          // Get current server version
          const lastChange = await database
            .select({ id: syncChanges.id })
            .from(syncChanges)
            .where(eq(syncChanges.userId, authUser.id))
            .orderBy(syncChanges.id)
            .limit(1)

          const serverVersion = lastChange[0]?.id ?? 0

          // Create client record
          const client: ConnectedClient = {
            ws: ws as unknown as ConnectedClient['ws'],
            userId: authUser.id,
            siteId,
            migrationVersion,
            lastServerVersion: BigInt(serverVersion),
          }

          // Store client
          if (!connectedClients.has(authUser.id)) {
            connectedClients.set(authUser.id, new Set())
          }
          connectedClients.get(authUser.id)!.add(client)

          wsData.data.authenticated = true
          wsData.data.client = client

          ws.send(
            JSON.stringify({
              type: 'auth_success',
              serverVersion: serverVersion.toString(),
            } satisfies WSResponse),
          )

          console.info(`WebSocket authenticated: user=${authUser.id}, site=${siteId}`)
          return
        }

        // All other messages require authentication
        if (!wsData.data.authenticated || !wsData.data.client) {
          ws.send(
            JSON.stringify({
              type: 'auth_error',
              error: 'Not authenticated',
            } satisfies WSResponse),
          )
          return
        }

        const client = wsData.data.client

        if (message.type === 'push') {
          // Handle push changes
          const { changes } = message

          if (!changes || changes.length === 0) {
            ws.send(
              JSON.stringify({
                type: 'push_success',
                serverVersion: client.lastServerVersion.toString(),
              } satisfies WSResponse),
            )
            return
          }

          // Update migration version if newer
          if (client.migrationVersion) {
            const currentVersion = await getRequiredMigrationVersion(database, client.userId)
            await updateMigrationVersionIfNewer(database, client.userId, client.migrationVersion, currentVersion)
          }

          // Insert changes
          const insertedChanges = await database
            .insert(syncChanges)
            .values(
              changes.map((change: SerializedChange) => ({
                userId: client.userId,
                siteId: client.siteId,
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

          const maxServerVersion = Math.max(...insertedChanges.map((c) => c.id))
          client.lastServerVersion = BigInt(maxServerVersion)

          // Send success to sender
          ws.send(
            JSON.stringify({
              type: 'push_success',
              serverVersion: maxServerVersion.toString(),
            } satisfies WSResponse),
          )

          // Broadcast changes to other connected clients of this user
          const serializedChanges: SerializedChange[] = changes.map((change: SerializedChange) => ({
            table: change.table,
            pk: change.pk,
            cid: change.cid,
            val: change.val,
            col_version: change.col_version,
            db_version: change.db_version,
            site_id: change.site_id,
            cl: change.cl,
            seq: change.seq,
          }))

          broadcastToUser(client.userId, client.siteId, {
            type: 'changes',
            changes: serializedChanges,
            serverVersion: maxServerVersion.toString(),
          })

          return
        }

        if (message.type === 'pull') {
          // Handle pull changes
          const since = message.since ? parseInt(message.since, 10) : 0

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
            .where(and(eq(syncChanges.userId, client.userId), gt(syncChanges.id, since)))
            .orderBy(syncChanges.id)
            .limit(1000)

          const maxServerVersion = changes.length > 0 ? Math.max(...changes.map((c) => c.id)) : since
          client.lastServerVersion = BigInt(maxServerVersion)

          const serializedChanges: SerializedChange[] = changes.map((change) => ({
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

          ws.send(
            JSON.stringify({
              type: 'changes',
              changes: serializedChanges,
              serverVersion: maxServerVersion.toString(),
            } satisfies WSResponse),
          )

          return
        }
      } catch (error) {
        console.error('WebSocket message error:', error)
        ws.send(
          JSON.stringify({
            type: 'push_error',
            error: error instanceof Error ? error.message : 'Unknown error',
          } satisfies WSResponse),
        )
      }
    },

    close(ws) {
      const wsData = ws as unknown as { data: { authenticated: boolean; client?: ConnectedClient } }

      if (wsData.data.client) {
        const client = wsData.data.client
        const userClients = connectedClients.get(client.userId)
        if (userClients) {
          userClients.delete(client)
          if (userClients.size === 0) {
            connectedClients.delete(client.userId)
          }
        }
        console.info(`WebSocket closed: user=${client.userId}, site=${client.siteId}`)
      } else {
        console.info('WebSocket closed (unauthenticated)')
      }
    },
  })
}

/**
 * Get count of connected clients (for monitoring)
 */
export const getConnectedClientsCount = (): number => {
  let count = 0
  for (const clients of connectedClients.values()) {
    count += clients.size
  }
  return count
}
