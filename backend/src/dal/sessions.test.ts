/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { session, user } from '@/db/auth-schema'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getActiveSessionByToken, linkSessionToDevice, revokeDeviceSessions } from './sessions'

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
    await cleanup()
  })

  it('returns session for valid non-expired token', async () => {
    const now = new Date()
    const future = new Date(now.getTime() + 3600_000)
    await db.insert(session).values({
      id: 's1',
      expiresAt: future,
      token: 'valid-token',
      createdAt: now,
      updatedAt: now,
      userId,
    })
    const result = await getActiveSessionByToken(db, 'valid-token')
    expect(result).toEqual({ userId })
  })

  it('returns null for expired token', async () => {
    const now = new Date()
    const past = new Date(now.getTime() - 3600_000)
    await db.insert(session).values({
      id: 's2',
      expiresAt: past,
      token: 'expired-token',
      createdAt: now,
      updatedAt: now,
      userId,
    })
    const result = await getActiveSessionByToken(db, 'expired-token')
    expect(result).toBeNull()
  })

  it('returns null for nonexistent token', async () => {
    const result = await getActiveSessionByToken(db, 'no-such-token')
    expect(result).toBeNull()
  })

  describe('linkSessionToDevice', () => {
    it('sets deviceId on the session', async () => {
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

      await linkSessionToDevice(db, 'link-session', 'device-abc', userId)

      const [row] = await db.select().from(session).where(eq(session.id, 'link-session'))
      expect(row.deviceId).toBe('device-abc')
    })

    it('overwrites previous deviceId', async () => {
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

      await linkSessionToDevice(db, 'relink-session', 'new-device', userId)

      const [row] = await db.select().from(session).where(eq(session.id, 'relink-session'))
      expect(row.deviceId).toBe('new-device')
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
