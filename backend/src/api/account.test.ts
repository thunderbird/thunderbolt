import { createAuth } from '@/auth/auth'
import { user } from '@/db/auth-schema'
import { chatThreadsTable, devicesTable, settingsTable, tasksTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createAccountRoutes } from './account'

describe('Account API', () => {
  let app: ReturnType<typeof createAccountRoutes>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    const auth = createAuth(db)
    app = new Elysia({ prefix: '/v1' }).use(createAccountRoutes(auth, db)) as unknown as ReturnType<
      typeof createAccountRoutes
    >
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('DELETE /v1/account', () => {
    it('should return 401 when not authenticated', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/account', {
          method: 'DELETE',
        }),
      )
      expect(response.status).toBe(401)
    })

    it('should return 401 when Authorization header is missing', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/account', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      expect(response.status).toBe(401)
    })

    it('should return 204 and hard-delete user and app data when session is valid', async () => {
      const userId = 'test-user-full-delete'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Test User',
        email: 'full-delete@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      const sessionTable = (await import('@/db/auth-schema')).session
      await db.insert(sessionTable).values({
        id: 'session-full-delete',
        expiresAt,
        token: 'bearer-token-full-delete',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await db.insert(settingsTable).values({
        key: 'test_setting',
        value: 'value',
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/v1/account', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer bearer-token-full-delete' },
        }),
      )

      expect(response.status).toBe(204)

      const usersLeft = await db.select().from(user).where(eq(user.id, userId))
      expect(usersLeft).toHaveLength(0)

      const settingsLeft = await db.select().from(settingsTable).where(eq(settingsTable.userId, userId))
      expect(settingsLeft).toHaveLength(0)
    })

    it('cascade deletes all PowerSync rows when user is deleted (user_id foreign keys)', async () => {
      const userId = 'test-user-cascade-delete'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Cascade User',
        email: 'cascade-delete@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      const sessionTable = (await import('@/db/auth-schema')).session
      await db.insert(sessionTable).values({
        id: 'session-cascade-delete',
        expiresAt,
        token: 'bearer-token-cascade-delete',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await db.insert(settingsTable).values({
        key: 'cascade_setting',
        value: 'v',
        userId,
      })
      await db.insert(devicesTable).values({
        id: 'device-cascade-1',
        userId,
        name: 'Device',
        lastSeen: now,
        createdAt: now,
      })
      await db.insert(tasksTable).values({
        id: 'task-cascade-1',
        item: 'Task',
        userId,
      })
      await db.insert(chatThreadsTable).values({
        id: 'thread-cascade-1',
        title: 'Thread',
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/v1/account', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer bearer-token-cascade-delete' },
        }),
      )

      expect(response.status).toBe(204)

      const usersLeft = await db.select().from(user).where(eq(user.id, userId))
      expect(usersLeft).toHaveLength(0)

      const settingsLeft = await db.select().from(settingsTable).where(eq(settingsTable.userId, userId))
      expect(settingsLeft).toHaveLength(0)

      const devicesLeft = await db.select().from(devicesTable).where(eq(devicesTable.userId, userId))
      expect(devicesLeft).toHaveLength(0)

      const tasksLeft = await db.select().from(tasksTable).where(eq(tasksTable.userId, userId))
      expect(tasksLeft).toHaveLength(0)

      const threadsLeft = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.userId, userId))
      expect(threadsLeft).toHaveLength(0)
    })
  })
})
