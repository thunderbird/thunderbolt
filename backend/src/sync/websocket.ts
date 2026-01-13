/**
 * WebSocket-based sync for real-time database synchronization
 * Replaces polling with instant push/pull via persistent WebSocket connections
 */

import type { Auth } from '@/auth/elysia-plugin'
import type { db as DbType } from '@/db/client'
import { Elysia, t } from 'elysia'
import {
  type SerializedChange,
  checkMigrationVersionRequirement,
  ensureMockUserExists,
  fetchChangesSince,
  getLatestServerVersion,
  getMaxServerVersion,
  insertChanges,
  MOCK_USER,
  serializeChanges,
  updateMigrationVersionIfNewer,
  upsertSyncDevice,
} from './shared'

/**
 * WebSocket message types
 */
type WSMessage =
  | {
      type: 'auth'
      siteId: string
      migrationVersion?: string
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
 * Create WebSocket sync routes for real-time database synchronization
 */
export const createSyncWebSocketRoutes = (database: typeof DbType, _auth: Auth) => {
  return new Elysia({ prefix: '/sync' }).ws('/ws', {
    body: t.Object({
      type: t.String(),
      siteId: t.Optional(t.String()),
      migrationVersion: t.Optional(t.String()),
      changes: t.Optional(t.Array(t.Any())),
      dbVersion: t.Optional(t.String()),
      since: t.Optional(t.String()),
    }),

    open(ws) {
      const wsData = ws as unknown as { data: { authenticated: boolean; client?: ConnectedClient } }
      wsData.data = { authenticated: false }
    },

    async message(ws, rawMessage) {
      const wsData = ws as unknown as { data: { authenticated: boolean; client?: ConnectedClient } }
      const message = rawMessage as unknown as WSMessage

      try {
        if (message.type === 'auth') {
          // Handle authentication
          // TODO: Use real auth from headers/cookies when available
          await ensureMockUserExists(database)
          const authUser = MOCK_USER

          const { siteId, migrationVersion } = message

          // Check migration version
          const { needsUpgrade, requiredVersion } = await checkMigrationVersionRequirement(
            database,
            authUser.id,
            migrationVersion,
          )

          if (needsUpgrade && requiredVersion) {
            ws.send(
              JSON.stringify({
                type: 'version_mismatch',
                requiredVersion,
              } satisfies WSResponse),
            )
            ws.close()
            return
          }

          // Upsert device record
          await upsertSyncDevice(database, authUser.id, siteId, migrationVersion)

          // Get current server version
          const serverVersion = await getLatestServerVersion(database, authUser.id)

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

          // Atomically update migration version if this client has a newer version
          await updateMigrationVersionIfNewer(database, client.userId, client.migrationVersion)

          // Insert changes
          const insertedChanges = await insertChanges(database, client.userId, client.siteId, changes)
          const maxServerVersion = getMaxServerVersion(insertedChanges, 0)
          client.lastServerVersion = BigInt(maxServerVersion)

          // Send success to sender
          ws.send(
            JSON.stringify({
              type: 'push_success',
              serverVersion: maxServerVersion.toString(),
            } satisfies WSResponse),
          )

          // Broadcast changes to other connected clients of this user
          broadcastToUser(client.userId, client.siteId, {
            type: 'changes',
            changes,
            serverVersion: maxServerVersion.toString(),
          })

          return
        }

        if (message.type === 'pull') {
          // Handle pull changes
          const since = message.since ? parseInt(message.since, 10) : 0

          const changes = await fetchChangesSince(database, client.userId, since)
          const maxServerVersion = getMaxServerVersion(changes, since)
          client.lastServerVersion = BigInt(maxServerVersion)

          ws.send(
            JSON.stringify({
              type: 'changes',
              changes: serializeChanges(changes),
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
