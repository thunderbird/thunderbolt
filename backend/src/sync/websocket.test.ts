import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import {
  ensureMockUserExists,
  fetchChangesSince,
  insertChanges,
  MOCK_USER,
  serializeChanges,
  updateMigrationVersionIfNewer,
} from './shared'
import { createSyncWebSocketRoutes, getConnectedClientsCount } from './websocket'

/**
 * Create a minimal test app with just WebSocket routes
 * This avoids initializing better-auth which has module issues in tests
 */
const createTestApp = (database: Awaited<ReturnType<typeof createTestDb>>['db']) => {
  const mockAuth = {} as Parameters<typeof createSyncWebSocketRoutes>[1]
  return new Elysia({ prefix: '/v1' }).use(createSyncWebSocketRoutes(database, mockAuth))
}

describe('Sync WebSocket', () => {
  let app: ReturnType<typeof createTestApp>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let server: { stop: () => void; hostname: string; port: number } | null = null

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    app = createTestApp(db)

    await ensureMockUserExists(db)

    // Start a real server for WebSocket testing
    server = Bun.serve({
      port: 0, // Random available port
      fetch: app.fetch,
      websocket: app.websocket,
    })
  })

  afterEach(async () => {
    server?.stop()
    server = null
    await cleanup()
  })

  const createWebSocket = (): WebSocket => {
    if (!server) throw new Error('Server not started')
    return new WebSocket(`ws://${server.hostname}:${server.port}/v1/sync/ws`)
  }

  const waitForOpen = (ws: WebSocket): Promise<void> => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket open timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(timeout)
        resolve()
      }
      ws.onerror = (e) => {
        clearTimeout(timeout)
        reject(e)
      }
    })
  }

  const waitForMessage = <T>(ws: WebSocket): Promise<T> => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket message timeout')), 5000)
      ws.onmessage = (event) => {
        clearTimeout(timeout)
        resolve(JSON.parse(event.data as string) as T)
      }
      ws.onerror = (e) => {
        clearTimeout(timeout)
        reject(e)
      }
    })
  }

  describe('Authentication', () => {
    it('connects and authenticates successfully', async () => {
      const ws = createWebSocket()
      await waitForOpen(ws)

      ws.send(
        JSON.stringify({
          type: 'auth',
          siteId: 'test-site-123',
          migrationVersion: '0001_test',
        }),
      )

      const response = await waitForMessage<{ type: string; serverVersion: string }>(ws)
      expect(response.type).toBe('auth_success')
      expect(response.serverVersion).toBeDefined()

      ws.close()
    })

    it('returns auth_error for unauthenticated push', async () => {
      const ws = createWebSocket()
      await waitForOpen(ws)

      // Send push without auth
      ws.send(
        JSON.stringify({
          type: 'push',
          changes: [],
          dbVersion: '1',
        }),
      )

      const response = await waitForMessage<{ type: string; error: string }>(ws)
      expect(response.type).toBe('auth_error')
      expect(response.error).toBe('Not authenticated')

      ws.close()
    })

    it('closes connection on version mismatch', async () => {
      // Set a required migration version
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0005_required', null)

      const ws = createWebSocket()
      await waitForOpen(ws)

      ws.send(
        JSON.stringify({
          type: 'auth',
          siteId: 'test-site-123',
          migrationVersion: '0001_old',
        }),
      )

      const response = await waitForMessage<{ type: string; requiredVersion: string }>(ws)
      expect(response.type).toBe('version_mismatch')
      expect(response.requiredVersion).toBe('0005_required')

      // Wait for close
      await new Promise<void>((resolve) => {
        ws.onclose = () => resolve()
        setTimeout(resolve, 100)
      })
    })
  })

  describe('Push', () => {
    it('pushes changes successfully', async () => {
      const ws = createWebSocket()
      await waitForOpen(ws)

      // Authenticate first
      ws.send(JSON.stringify({ type: 'auth', siteId: 'test-site-123' }))
      await waitForMessage(ws)

      // Push changes
      ws.send(
        JSON.stringify({
          type: 'push',
          changes: [
            {
              table: 'test_table',
              pk: 'pk1',
              cid: 'col1',
              val: 'value1',
              col_version: '1',
              db_version: '1',
              site_id: 'test-site-123',
              cl: 1,
              seq: 0,
            },
          ],
          dbVersion: '1',
        }),
      )

      const response = await waitForMessage<{ type: string; serverVersion: string }>(ws)
      expect(response.type).toBe('push_success')
      expect(parseInt(response.serverVersion)).toBeGreaterThan(0)

      ws.close()
    })

    it('returns push_success with empty changes', async () => {
      const ws = createWebSocket()
      await waitForOpen(ws)

      ws.send(JSON.stringify({ type: 'auth', siteId: 'test-site-123' }))
      await waitForMessage(ws)

      ws.send(
        JSON.stringify({
          type: 'push',
          changes: [],
          dbVersion: '1',
        }),
      )

      const response = await waitForMessage<{ type: string; serverVersion: string }>(ws)
      expect(response.type).toBe('push_success')

      ws.close()
    })
  })

  describe('Pull', () => {
    it('pulls changes successfully', async () => {
      // Insert some changes first
      await insertChanges(db, MOCK_USER.id, 'other-device', [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: 'value1',
          col_version: '1',
          db_version: '1',
          site_id: 'other-device',
          cl: 1,
          seq: 0,
        },
      ])

      const ws = createWebSocket()
      await waitForOpen(ws)

      ws.send(JSON.stringify({ type: 'auth', siteId: 'test-site-123' }))
      await waitForMessage(ws)

      ws.send(JSON.stringify({ type: 'pull', since: '0' }))

      const response = await waitForMessage<{ type: string; changes: unknown[]; serverVersion: string }>(ws)
      expect(response.type).toBe('changes')
      expect(response.changes).toHaveLength(1)
      expect(parseInt(response.serverVersion)).toBeGreaterThan(0)

      ws.close()
    })

    it('returns empty changes when none exist', async () => {
      const ws = createWebSocket()
      await waitForOpen(ws)

      ws.send(JSON.stringify({ type: 'auth', siteId: 'test-site-123' }))
      await waitForMessage(ws)

      ws.send(JSON.stringify({ type: 'pull', since: '0' }))

      const response = await waitForMessage<{ type: string; changes: unknown[]; serverVersion: string }>(ws)
      expect(response.type).toBe('changes')
      expect(response.changes).toHaveLength(0)

      ws.close()
    })
  })

  describe('Broadcasting', () => {
    it('broadcasts changes to other connected clients', async () => {
      // Connect two clients
      const ws1 = createWebSocket()
      const ws2 = createWebSocket()

      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)])

      // Authenticate both
      ws1.send(JSON.stringify({ type: 'auth', siteId: 'device-1' }))
      ws2.send(JSON.stringify({ type: 'auth', siteId: 'device-2' }))

      await Promise.all([waitForMessage(ws1), waitForMessage(ws2)])

      // Set up listener for broadcast on ws2
      const broadcastPromise = waitForMessage<{ type: string; changes: unknown[] }>(ws2)

      // Push from ws1
      ws1.send(
        JSON.stringify({
          type: 'push',
          changes: [
            {
              table: 'test_table',
              pk: 'pk1',
              cid: 'col1',
              val: 'broadcast-test',
              col_version: '1',
              db_version: '1',
              site_id: 'device-1',
              cl: 1,
              seq: 0,
            },
          ],
          dbVersion: '1',
        }),
      )

      // Wait for push_success on ws1
      const pushResponse = await waitForMessage<{ type: string }>(ws1)
      expect(pushResponse.type).toBe('push_success')

      // Wait for broadcast on ws2
      const broadcastResponse = await broadcastPromise
      expect(broadcastResponse.type).toBe('changes')
      expect(broadcastResponse.changes).toHaveLength(1)

      ws1.close()
      ws2.close()
    })
  })

  describe('Connection Management', () => {
    it('tracks connected clients count', async () => {
      const initialCount = getConnectedClientsCount()

      const ws = createWebSocket()
      await waitForOpen(ws)

      ws.send(JSON.stringify({ type: 'auth', siteId: 'test-site-123' }))
      await waitForMessage(ws)

      expect(getConnectedClientsCount()).toBe(initialCount + 1)

      ws.close()

      // Wait for close to be processed
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(getConnectedClientsCount()).toBe(initialCount)
    })
  })

  describe('Integration', () => {
    it('full sync flow: push then pull from another device', async () => {
      // Device 1 pushes changes
      const ws1 = createWebSocket()
      await waitForOpen(ws1)

      ws1.send(JSON.stringify({ type: 'auth', siteId: 'device-1' }))
      const authResponse1 = await waitForMessage<{ serverVersion: string }>(ws1)
      const initialVersion = authResponse1.serverVersion

      ws1.send(
        JSON.stringify({
          type: 'push',
          changes: [
            {
              table: 'notes',
              pk: 'note-1',
              cid: 'title',
              val: 'My Note',
              col_version: '1',
              db_version: '1',
              site_id: 'device-1',
              cl: 1,
              seq: 0,
            },
          ],
          dbVersion: '1',
        }),
      )

      const pushResponse = await waitForMessage<{ type: string; serverVersion: string }>(ws1)
      expect(pushResponse.type).toBe('push_success')

      ws1.close()

      // Device 2 connects and pulls changes
      const ws2 = createWebSocket()
      await waitForOpen(ws2)

      ws2.send(JSON.stringify({ type: 'auth', siteId: 'device-2' }))
      await waitForMessage(ws2)

      ws2.send(JSON.stringify({ type: 'pull', since: initialVersion }))

      const pullResponse = await waitForMessage<{ type: string; changes: Array<{ table: string; val: unknown }> }>(ws2)
      expect(pullResponse.type).toBe('changes')
      expect(pullResponse.changes).toHaveLength(1)
      expect(pullResponse.changes[0].table).toBe('notes')
      expect(pullResponse.changes[0].val).toBe('My Note')

      ws2.close()
    })
  })
})

describe('Sync WebSocket Utilities', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    await ensureMockUserExists(db)
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('serializeChanges for WebSocket', () => {
    it('serializes changes for WebSocket transport', async () => {
      await insertChanges(db, MOCK_USER.id, 'site-123', [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: 'test-value',
          col_version: '1',
          db_version: '1',
          site_id: 'site-123',
          cl: 1,
          seq: 0,
        },
      ])

      const rawChanges = await fetchChangesSince(db, MOCK_USER.id, 0)
      const serialized = serializeChanges(rawChanges)

      expect(serialized).toHaveLength(1)
      expect(typeof serialized[0].col_version).toBe('string')
      expect(typeof serialized[0].db_version).toBe('string')
    })
  })
})
