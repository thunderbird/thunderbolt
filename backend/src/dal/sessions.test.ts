/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { session, user } from '@/db/auth-schema'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  cliRegistrationPendingDeviceId,
  getActivePersistedSession,
  linkCliSessionToDevice,
  linkSessionToDevice,
  revokeDeviceSessions,
} from './sessions'

describe('sessions DAL', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  const userId = 'test-user-sessions'

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup

    const now = new Date()
    await db.insert(user).values({
      id: userId,
      name: 'Test User',
      email: 'sessions@test.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  describe('getActivePersistedSession', () => {
    it('returns the persisted session identity and current device binding for an unexpired raw token', async () => {
      const now = new Date()
      await db.insert(session).values({
        id: 'persisted-session',
        expiresAt: new Date(now.getTime() + 3600_000),
        token: 'persisted-token',
        createdAt: now,
        updatedAt: now,
        userId,
        deviceId: 'persisted-device',
      })

      expect(await getActivePersistedSession(db, 'persisted-token')).toEqual({
        id: 'persisted-session',
        userId,
        deviceId: 'persisted-device',
      })
    })

    it('returns null for an expired persisted session', async () => {
      const now = new Date()
      await db.insert(session).values({
        id: 'expired-persisted-session',
        expiresAt: new Date(now.getTime() - 1),
        token: 'expired-persisted-token',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      expect(await getActivePersistedSession(db, 'expired-persisted-token')).toBeNull()
    })
  })

  describe('linkSessionToDevice', () => {
    it('binds an unbound session and permits an idempotent bind to the same device', async () => {
      const now = new Date()
      const future = new Date(now.getTime() + 3600_000)
      await db.insert(session).values({
        id: 'link-session',
        expiresAt: future,
        token: 'link-token',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      expect(await linkSessionToDevice(db, 'link-session', 'device-abc', userId)).toEqual({ status: 'bound' })
      expect(await linkSessionToDevice(db, 'link-session', 'device-abc', userId)).toEqual({ status: 'bound' })

      const [row] = await db.select().from(session).where(eq(session.id, 'link-session'))
      expect(row.deviceId).toBe('device-abc')
    })

    it('rejects rebinding a session that is already bound to another device', async () => {
      const now = new Date()
      const future = new Date(now.getTime() + 3600_000)
      await db.insert(session).values({
        id: 'relink-session',
        expiresAt: future,
        token: 'relink-token',
        createdAt: now,
        updatedAt: now,
        userId,
        deviceId: 'old-device',
      })

      expect(await linkSessionToDevice(db, 'relink-session', 'new-device', userId)).toEqual({ status: 'conflict' })

      const [row] = await db.select().from(session).where(eq(session.id, 'relink-session'))
      expect(row.deviceId).toBe('old-device')
    })

    it('only replaces the server marker through the CLI registration binder', async () => {
      const now = new Date()
      await db.insert(session).values({
        id: 'cli-pending-session',
        expiresAt: new Date(now.getTime() + 3600_000),
        token: 'cli-pending-token',
        createdAt: now,
        updatedAt: now,
        userId,
        deviceId: cliRegistrationPendingDeviceId,
      })

      expect(await linkSessionToDevice(db, 'cli-pending-session', 'normal-device', userId)).toEqual({
        status: 'conflict',
      })
      expect(await linkCliSessionToDevice(db, 'cli-pending-session', 'cli-device', userId)).toEqual({
        status: 'bound',
      })
      const [row] = await db.select().from(session).where(eq(session.id, 'cli-pending-session'))
      expect(row.deviceId).toBe('cli-device')
    })

    it('reports an invalid session without creating a binding', async () => {
      expect(await linkSessionToDevice(db, 'missing-session', 'device-abc', userId)).toEqual({
        status: 'invalid-session',
      })
    })

    it('reports an expired session as invalid without changing its device binding', async () => {
      const now = new Date()
      await db.insert(session).values({
        id: 'expired-link-session',
        expiresAt: new Date(now.getTime() - 1),
        token: 'expired-link-token',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      expect(await linkSessionToDevice(db, 'expired-link-session', 'device-abc', userId)).toEqual({
        status: 'invalid-session',
      })
      const [persisted] = await db.select().from(session).where(eq(session.id, 'expired-link-session'))
      expect(persisted.deviceId).toBeNull()
    })

    it('atomically allows only one of two competing device bindings', async () => {
      const now = new Date()
      await db.insert(session).values({
        id: 'race-session',
        expiresAt: new Date(now.getTime() + 3600_000),
        token: 'race-token',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const results = await Promise.all([
        linkSessionToDevice(db, 'race-session', 'race-device-a', userId),
        linkSessionToDevice(db, 'race-session', 'race-device-b', userId),
      ])

      expect(results.map(({ status }) => status).sort()).toEqual(['bound', 'conflict'])
      const [persisted] = await db.select().from(session).where(eq(session.id, 'race-session'))
      if (!persisted.deviceId) {
        throw new Error('winning session binding was not persisted')
      }
      expect(['race-device-a', 'race-device-b']).toContain(persisted.deviceId)
    })
  })

  describe('revokeDeviceSessions', () => {
    it('deletes all sessions linked to the device', async () => {
      const now = new Date()
      const future = new Date(now.getTime() + 3600_000)
      await db.insert(session).values([
        {
          id: 'dev-session-1',
          expiresAt: future,
          token: 'dev-token-1',
          createdAt: now,
          updatedAt: now,
          userId,
          deviceId: 'target-device',
        },
        {
          id: 'dev-session-2',
          expiresAt: future,
          token: 'dev-token-2',
          createdAt: now,
          updatedAt: now,
          userId,
          deviceId: 'target-device',
        },
      ])

      await revokeDeviceSessions(db, 'target-device', userId)

      const remaining = await db.select().from(session).where(eq(session.userId, userId))
      expect(remaining).toHaveLength(0)
    })

    it('does not delete sessions linked to other devices', async () => {
      const now = new Date()
      const future = new Date(now.getTime() + 3600_000)
      await db.insert(session).values([
        {
          id: 'target-session',
          expiresAt: future,
          token: 'target-token',
          createdAt: now,
          updatedAt: now,
          userId,
          deviceId: 'revoked-device',
        },
        {
          id: 'other-session',
          expiresAt: future,
          token: 'other-token',
          createdAt: now,
          updatedAt: now,
          userId,
          deviceId: 'safe-device',
        },
      ])

      await revokeDeviceSessions(db, 'revoked-device', userId)

      const remaining = await db.select().from(session).where(eq(session.userId, userId))
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('other-session')
    })

    it('does not delete sessions without a deviceId', async () => {
      const now = new Date()
      const future = new Date(now.getTime() + 3600_000)
      await db.insert(session).values({
        id: 'no-device-session',
        expiresAt: future,
        token: 'no-device-token',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await revokeDeviceSessions(db, 'some-device', userId)

      const remaining = await db.select().from(session).where(eq(session.id, 'no-device-session'))
      expect(remaining).toHaveLength(1)
    })
  })
})
