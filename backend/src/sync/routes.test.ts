import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createSyncRoutes } from './routes'
import { ensureMockUserExists, insertChanges, MOCK_USER, updateMigrationVersionIfNewer } from './shared'

/**
 * Create a minimal test app with just sync routes
 * This avoids initializing better-auth which has module issues in tests
 */
const createTestApp = (database: Awaited<ReturnType<typeof createTestDb>>['db']) => {
  // Create a minimal mock auth object
  const mockAuth = {} as Parameters<typeof createSyncRoutes>[1]

  return new Elysia({ prefix: '/v1' }).use(createSyncRoutes(database, mockAuth))
}

describe('Sync Routes', () => {
  let app: ReturnType<typeof createTestApp>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    app = createTestApp(db)

    // Ensure mock user exists for all tests
    await ensureMockUserExists(db)
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('POST /sync/push', () => {
    it('returns success with empty changes', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/sync/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            siteId: 'site-123',
            changes: [],
            dbVersion: '1',
          }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.success).toBe(true)
      expect(data.serverVersion).toBeDefined()
    })

    it('pushes changes successfully', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/sync/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            siteId: 'site-123',
            changes: [
              {
                table: 'test_table',
                pk: 'pk1',
                cid: 'col1',
                val: 'value1',
                col_version: '1',
                db_version: '1',
                site_id: 'site-123',
                cl: 1,
                seq: 0,
              },
            ],
            dbVersion: '1',
            migrationVersion: '0001_test',
          }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.success).toBe(true)
      expect(parseInt(data.serverVersion)).toBeGreaterThan(0)
    })

    it('returns validation error for missing required fields', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/sync/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )

      expect(response.status).toBe(400)
    })

    it('returns needsUpgrade when client version is outdated', async () => {
      // Set a required migration version
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0005_required')

      const response = await app.handle(
        new Request('http://localhost/v1/sync/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            siteId: 'site-123',
            changes: [],
            dbVersion: '1',
            migrationVersion: '0001_old',
          }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.success).toBe(false)
      expect(data.needsUpgrade).toBe(true)
      expect(data.requiredVersion).toBe('0005_required')
    })
  })

  describe('GET /sync/pull', () => {
    it('returns empty changes when none exist', async () => {
      const response = await app.handle(new Request('http://localhost/v1/sync/pull?since=0'))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.changes).toEqual([])
      expect(data.serverVersion).toBe('0')
    })

    it('returns changes since given version', async () => {
      // Insert some changes
      await insertChanges(db, MOCK_USER.id, 'site-123', [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: 'value1',
          col_version: '1',
          db_version: '1',
          site_id: 'site-123',
          cl: 1,
          seq: 0,
        },
      ])

      const response = await app.handle(new Request('http://localhost/v1/sync/pull?since=0'))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.changes).toHaveLength(1)
      expect(data.changes[0].table).toBe('test_table')
      expect(parseInt(data.serverVersion)).toBeGreaterThan(0)
    })

    it('filters changes by since parameter', async () => {
      // Insert two changes
      const inserted = await insertChanges(db, MOCK_USER.id, 'site-123', [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: 'value1',
          col_version: '1',
          db_version: '1',
          site_id: 'site-123',
          cl: 1,
          seq: 0,
        },
        {
          table: 'test_table',
          pk: 'pk2',
          cid: 'col1',
          val: 'value2',
          col_version: '2',
          db_version: '2',
          site_id: 'site-123',
          cl: 1,
          seq: 1,
        },
      ])

      // Pull only changes after the first one
      const response = await app.handle(new Request(`http://localhost/v1/sync/pull?since=${inserted[0].id}`))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.changes).toHaveLength(1)
      expect(data.changes[0].pk).toBe('pk2')
    })

    it('returns needsUpgrade when client version is outdated', async () => {
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0005_required')

      const response = await app.handle(new Request('http://localhost/v1/sync/pull?since=0&migrationVersion=0001_old'))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.changes).toEqual([])
      expect(data.needsUpgrade).toBe(true)
      expect(data.requiredVersion).toBe('0005_required')
    })

    it('requires since parameter', async () => {
      const response = await app.handle(new Request('http://localhost/v1/sync/pull'))

      expect(response.status).toBe(422)
    })
  })

  describe('GET /sync/version', () => {
    it('returns 0 when no changes exist', async () => {
      const response = await app.handle(new Request('http://localhost/v1/sync/version'))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.serverVersion).toBe('0')
    })

    it('returns latest version after changes', async () => {
      await insertChanges(db, MOCK_USER.id, 'site-123', [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: 'value1',
          col_version: '1',
          db_version: '1',
          site_id: 'site-123',
          cl: 1,
          seq: 0,
        },
      ])

      const response = await app.handle(new Request('http://localhost/v1/sync/version'))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(parseInt(data.serverVersion)).toBeGreaterThan(0)
    })
  })

  describe('Push/Pull Integration', () => {
    it('changes pushed are available for pull', async () => {
      // Push a change
      const pushResponse = await app.handle(
        new Request('http://localhost/v1/sync/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            siteId: 'device-1',
            changes: [
              {
                table: 'notes',
                pk: 'note-1',
                cid: 'content',
                val: 'Hello World',
                col_version: '1',
                db_version: '1',
                site_id: 'device-1',
                cl: 1,
                seq: 0,
              },
            ],
            dbVersion: '1',
          }),
        }),
      )

      expect(pushResponse.status).toBe(200)

      // Pull from another device
      const pullResponse = await app.handle(new Request('http://localhost/v1/sync/pull?since=0&siteId=device-2'))

      expect(pullResponse.status).toBe(200)
      const data = await pullResponse.json()
      expect(data.changes).toHaveLength(1)
      expect(data.changes[0].table).toBe('notes')
      expect(data.changes[0].val).toBe('Hello World')
    })
  })
})
