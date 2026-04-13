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
 * Fix: p() prefixes every ID with a globalThis counter that survives module re-evaluation
 * (bun's --rerun-each reloads the module, resetting module-scope variables).
 */
const counterKey = Symbol.for('account-test-runId')
;(globalThis as Record<symbol, number>)[counterKey] ??= 0

describe('Account API', () => {
  let app: ReturnType<typeof createAccountRoutes>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  /** Prefix IDs with the current runId — see top-of-file comment for why. */
  let p: (id: string) => string

  beforeEach(async () => {
    const rid = ++(globalThis as Record<symbol, number>)[counterKey]
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

  describe('POST /v1/account/devices', () => {
    it('registers a new device', async () => {
      const userId = 'test-user-register-device'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Register Device User',
        email: 'register-device@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-register-device',
        expiresAt,
        token: 'bearer-register-device',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/v1/account/devices', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-register-device')}`,
          },
          body: JSON.stringify({ id: 'new-device-123', name: 'My Phone' }),
        }),
      )
      expect(response.status).toBe(201)

      const devices = await db.select().from(devicesTable).where(eq(devicesTable.id, 'new-device-123'))
      expect(devices).toHaveLength(1)
      expect(devices[0]?.userId).toBe(userId)
      expect(devices[0]?.name).toBe('My Phone')
    })

    it('returns 200 when device is already registered for same user', async () => {
      const userId = 'test-user-device-exists'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Existing Device User',
        email: 'existing-device@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-existing-device',
        expiresAt,
        token: 'bearer-existing-device',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await db.insert(devicesTable).values({
        id: 'existing-device-id',
        userId,
        name: 'Existing Device',
        lastSeen: now,
        createdAt: now,
      })

      const response = await app.handle(
        new Request('http://localhost/v1/account/devices', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-existing-device')}`,
          },
          body: JSON.stringify({ id: 'existing-device-id' }),
        }),
      )
      expect(response.status).toBe(200)
    })

    it('returns 409 when device ID belongs to another user', async () => {
      const userA = 'test-user-device-owner'
      const userB = 'test-user-device-thief'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values([
        {
          id: userA,
          name: 'User A',
          email: 'device-owner@example.com',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: userB,
          name: 'User B',
          email: 'device-thief@example.com',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ])

      await db.insert(sessionTable).values({
        id: 'session-device-thief',
        expiresAt,
        token: 'bearer-device-thief',
        createdAt: now,
        updatedAt: now,
        userId: userB,
      })

      await db.insert(devicesTable).values({
        id: 'owned-device',
        userId: userA,
        name: 'User A Device',
        lastSeen: now,
        createdAt: now,
      })

      const response = await app.handle(
        new Request('http://localhost/v1/account/devices', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-device-thief')}`,
          },
          body: JSON.stringify({ id: 'owned-device' }),
        }),
      )
      expect(response.status).toBe(409)
      const data = await response.json()
      expect(data).toEqual({ code: 'DEVICE_ID_TAKEN' })
    })

    it('returns 403 when device ID was revoked', async () => {
      const userId = 'test-user-revoked-register'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Revoked Register User',
        email: 'revoked-register@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-revoked-register',
        expiresAt,
        token: 'bearer-revoked-register',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await db.insert(devicesTable).values({
        id: 'revoked-device-reg',
        userId,
        name: 'Revoked Device',
        lastSeen: now,
        createdAt: now,
        revokedAt: now,
      })

      const response = await app.handle(
        new Request('http://localhost/v1/account/devices', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-revoked-register')}`,
          },
          body: JSON.stringify({ id: 'revoked-device-reg' }),
        }),
      )
      expect(response.status).toBe(403)
      const data = await response.json()
      expect(data).toEqual({ code: 'DEVICE_DISCONNECTED' })
    })

    it('returns 401 when not authenticated', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/account/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'some-device' }),
        }),
      )
      expect(response.status).toBe(401)
    })
  })

  describe('POST /v1/account/devices/:id/revoke', () => {
    it('invalidates all other sessions when device is revoked', async () => {
      const userId = p('session-revoke-user')
      const token = p('session-revoke-token')
      const attackerToken = p('session-revoke-attacker-token')
      const deviceId = p('device-to-revoke')
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Session Revoke User',
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      // Create two sessions: one for the user revoking, one for the attacker
      const sessionId = p('session-user-revoking')
      const attackerSessionId = p('session-attacker')
      await db.insert(sessionTable).values([
        {
          id: sessionId,
          expiresAt,
          token,
          createdAt: now,
          updatedAt: now,
          userId,
        },
        {
          id: attackerSessionId,
          expiresAt,
          token: attackerToken,
          createdAt: now,
          updatedAt: now,
          userId,
        },
      ])

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Compromised Device',
        lastSeen: now,
        createdAt: now,
      })

      // Revoke the device from the user's session
      const response = await app.handle(
        new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${signToken(token)}` },
        }),
      )
      expect(response.status).toBe(204)

      // The revoking user's session should still exist
      const revokingSession = await db.select().from(sessionTable).where(eq(sessionTable.id, sessionId))
      expect(revokingSession).toHaveLength(1)

      // The attacker's session should be deleted
      const attackerSession = await db.select().from(sessionTable).where(eq(sessionTable.id, attackerSessionId))
      expect(attackerSession).toHaveLength(0)
    })

    it('preserves revoking session even when it is the only session', async () => {
      const userId = p('single-session-user')
      const token = p('single-session-token')
      const sessionId = p('session-only-one')
      const deviceId = p('device-single-session')
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Single Session User',
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: sessionId,
        expiresAt,
        token,
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Device',
        lastSeen: now,
        createdAt: now,
      })

      const response = await app.handle(
        new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${signToken(token)}` },
        }),
      )
      expect(response.status).toBe(204)

      // Session should still exist
      const sessions = await db.select().from(sessionTable).where(eq(sessionTable.id, sessionId))
      expect(sessions).toHaveLength(1)
    })

    it('does not invalidate sessions when revoking a nonexistent device', async () => {
      const userId = p('nonexistent-revoke-user')
      const token = p('nonexistent-revoke-token')
      const otherToken = p('nonexistent-revoke-other-token')
      const sessionId = p('session-revoker')
      const otherSessionId = p('session-other')
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Nonexistent Revoke User',
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values([
        {
          id: sessionId,
          expiresAt,
          token,
          createdAt: now,
          updatedAt: now,
          userId,
        },
        {
          id: otherSessionId,
          expiresAt,
          token: otherToken,
          createdAt: now,
          updatedAt: now,
          userId,
        },
      ])

      // Revoke a device that doesn't exist
      const response = await app.handle(
        new Request('http://localhost/v1/account/devices/nonexistent-device/revoke', {
          method: 'POST',
          headers: { Authorization: `Bearer ${signToken(token)}` },
        }),
      )
      expect(response.status).toBe(204)

      // Both sessions should still exist — no device was actually revoked
      const revokerSession = await db.select().from(sessionTable).where(eq(sessionTable.id, sessionId))
      expect(revokerSession).toHaveLength(1)
      const otherSession = await db.select().from(sessionTable).where(eq(sessionTable.id, otherSessionId))
      expect(otherSession).toHaveLength(1)
    })
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
        trusted: true,
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
          headers: { Authorization: `Bearer ${signToken(token)}` },
        }),
      )

      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
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
        trusted: true,
      })

      const response = await app.handle(
        new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${signToken(tokenA)}` },
        }),
      )

      // Returns 204 (idempotent) but device is NOT actually revoked
      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.trusted).toBe(true)
      expect(device.revokedAt).toBeNull()
    })

    it('returns 204 for non-existent device (idempotent)', async () => {
      const userId = p('revoke-nonexistent-user')
      const token = p('revoke-nonexistent-token')
      await createUserAndSession(userId, token)

      const response = await app.handle(
        new Request(`http://localhost/v1/account/devices/${p('does-not-exist')}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${signToken(token)}` },
        }),
      )

      expect(response.status).toBe(204)
    })

    it('returns 204 when revoking already-revoked device (preserves original revokedAt)', async () => {
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
        trusted: true,
      })

      // First revoke
      const firstResponse = await app.handle(
        new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${signToken(token)}` },
        }),
      )
      expect(firstResponse.status).toBe(204)

      const [afterFirst] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      const originalRevokedAt = afterFirst.revokedAt

      // Second revoke — no-op because isNull(revokedAt) guard skips already-revoked devices
      const response = await app.handle(
        new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${signToken(token)}` },
        }),
      )

      expect(response.status).toBe(204)

      // Original revokedAt timestamp is preserved
      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.revokedAt).toEqual(originalRevokedAt)
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
        trusted: false,
      })

      const response = await app.handle(
        new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${signToken(token)}` },
        }),
      )

      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.revokedAt).not.toBeNull()

      const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.deviceId, deviceId))
      expect(envelopes).toHaveLength(0)
    })
  })
})
