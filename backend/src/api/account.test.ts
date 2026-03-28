import { createAuth } from '@/auth/auth'
import { session as sessionTable, user } from '@/db/auth-schema'
import { envelopesTable } from '@/db/encryption-schema'
import { chatThreadsTable, devicesTable, settingsTable, tasksTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createAccountRoutes } from './account'

const betterAuthSecret = 'better-auth-secret-12345678901234567890'
const signToken = (token: string): string => {
  const sig = createHmac('sha256', betterAuthSecret).update(token).digest('base64')
  return `${token}.${sig}`
}

/**
 * Unique-ID strategy for PGlite + nested transactions:
 *
 * The revoke endpoint calls database.transaction() internally. In PGlite's
 * single-connection model this commits the outer test transaction (started by
 * createTestDb's BEGIN), so ROLLBACK in afterEach becomes a no-op and rows persist.
 * CI runs each file 5× (test:backend:5x), so the second run would hit
 * unique-constraint violations without unique IDs.
 *
 * Fix: a monotonic runId prefixed onto every ID via p() ensures no collisions.
 */
let runId = 0

describe('Account API', () => {
  let app: ReturnType<typeof createAccountRoutes>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  /** Prefix IDs with the current runId — see top-of-file comment for why. */
  let p: (id: string) => string

  beforeEach(async () => {
    const rid = ++runId
    p = (id: string) => `${rid}-${id}`
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
          headers: { Authorization: `Bearer ${signToken('bearer-token-full-delete')}` },
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
          headers: { Authorization: `Bearer ${signToken('bearer-token-cascade-delete')}` },
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

  describe('POST /v1/account/devices/:id/revoke', () => {
    const createUserAndSession = async (userId: string, token: string) => {
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Test User',
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: `session-${userId}`,
        expiresAt,
        token,
        createdAt: now,
        updatedAt: now,
        userId,
      })

      return now
    }

    it('returns 401 without auth', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/account/devices/some-device/revoke', {
          method: 'POST',
        }),
      )
      expect(response.status).toBe(401)
    })

    it('returns 401 with invalid token', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/account/devices/some-device/revoke', {
          method: 'POST',
          headers: { Authorization: 'Bearer bogus-token' },
        }),
      )
      expect(response.status).toBe(401)
    })

    it('returns 204 and revokes device + deletes envelope', async () => {
      const userId = p('revoke-user')
      const token = p('revoke-token')
      const deviceId = p('device-to-revoke')
      const now = await createUserAndSession(userId, token)

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'My Device',
        lastSeen: now,
        createdAt: now,
        status: 'TRUSTED',
      })

      await db.insert(envelopesTable).values({
        deviceId,
        userId,
        wrappedCk: 'wrapped-key-data',
        updatedAt: now,
      })

      const response = await app.handle(
        new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }),
      )

      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.status).toBe('REVOKED')
      expect(device.revokedAt).not.toBeNull()

      const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.deviceId, deviceId))
      expect(envelopes).toHaveLength(0)
    })

    it('does not revoke device belonging to different user', async () => {
      const userAId = p('user-a-revoke')
      const userBId = p('user-b-revoke')
      const tokenA = p('token-user-a')
      const deviceId = p('device-user-b')

      await createUserAndSession(userAId, tokenA)
      const now = await createUserAndSession(userBId, p('token-user-b'))

      await db.insert(devicesTable).values({
        id: deviceId,
        userId: userBId,
        name: 'User B Device',
        lastSeen: now,
        createdAt: now,
        status: 'TRUSTED',
      })

      const response = await app.handle(
        new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenA}` },
        }),
      )

      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.status).toBe('TRUSTED')
      expect(device.revokedAt).toBeNull()
    })

    it('returns 204 for non-existent device (no-op)', async () => {
      const userId = p('revoke-nonexistent-user')
      const token = p('revoke-nonexistent-token')
      await createUserAndSession(userId, token)

      const response = await app.handle(
        new Request(`http://localhost/v1/account/devices/${p('does-not-exist')}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }),
      )

      expect(response.status).toBe(204)
    })

    it('returns 204 when revoking already-revoked device (idempotent)', async () => {
      const userId = p('revoke-idempotent-user')
      const token = p('revoke-idempotent-token')
      const deviceId = p('device-already-revoked')
      const now = await createUserAndSession(userId, token)

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Already Revoked',
        lastSeen: now,
        createdAt: now,
        status: 'TRUSTED',
      })

      // First revoke
      await app.handle(
        new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }),
      )

      // Second revoke
      const response = await app.handle(
        new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }),
      )

      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.status).toBe('REVOKED')
      expect(device.revokedAt).not.toBeNull()
    })

    it('handles device with no envelope gracefully', async () => {
      const userId = p('revoke-no-envelope-user')
      const token = p('revoke-no-envelope-token')
      const deviceId = p('device-no-envelope')
      const now = await createUserAndSession(userId, token)

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Pending Device',
        lastSeen: now,
        createdAt: now,
        status: 'APPROVAL_PENDING',
      })

      const response = await app.handle(
        new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }),
      )

      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.status).toBe('REVOKED')
      expect(device.revokedAt).not.toBeNull()

      const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.deviceId, deviceId))
      expect(envelopes).toHaveLength(0)
    })
  })
})
