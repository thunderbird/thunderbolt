/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { devicesTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { countActiveDevices, getDeviceById, revokeDevice, upsertDevice } from './devices'

describe('devices DAL', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  const userId = 'test-user-devices'

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup

    const now = new Date()
    await db.insert(user).values({
      id: userId,
      name: 'Test User',
      email: 'devices@test.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('getDeviceById', () => {
    it('returns device when found', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({ id: 'd1', userId, name: 'Phone', lastSeen: now, createdAt: now })
      const result = await getDeviceById(db, 'd1')
      expect(result).not.toBeNull()
      expect(result!.userId).toBe(userId)
      expect(result!.trusted).toBe(false)
      expect(result!.publicKey).toBeNull()
      expect(result!.revokedAt).toBeNull()
    })

    it('returns null when not found', async () => {
      const result = await getDeviceById(db, 'nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('upsertDevice', () => {
    it('inserts a new device', async () => {
      const now = new Date()
      const result = await upsertDevice(db, { id: 'd2', userId, name: 'Laptop', lastSeen: now, createdAt: now })
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Laptop')
    })

    it('updates lastSeen on conflict', async () => {
      const now = new Date()
      await upsertDevice(db, { id: 'd3', userId, name: 'Tablet', lastSeen: now, createdAt: now })
      const later = new Date(now.getTime() + 60000)
      await upsertDevice(db, { id: 'd3', userId, name: 'Tablet Updated', lastSeen: later, createdAt: now })
      const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, 'd3'))
      expect(rows[0].name).toBe('Tablet Updated')
    })
  })

  describe('revokeDevice', () => {
    it('sets revokedAt on the device', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({ id: 'd4', userId, name: 'Old Phone', lastSeen: now, createdAt: now })
      await revokeDevice(db, 'd4', userId)
      const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, 'd4'))
      expect(rows[0].revokedAt).not.toBeNull()
    })

    it('does not revoke device for wrong user', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({ id: 'd5', userId, name: 'Phone', lastSeen: now, createdAt: now })
      await revokeDevice(db, 'd5', 'other-user')
      const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, 'd5'))
      expect(rows[0].revokedAt).toBeNull()
    })
  })

  describe('countActiveDevices', () => {
    it('counts non-revoked devices for user', async () => {
      const now = new Date()
      await db.insert(devicesTable).values([
        { id: 'active-1', userId, name: 'Phone', lastSeen: now, createdAt: now },
        { id: 'active-2', userId, name: 'Laptop', lastSeen: now, createdAt: now },
        { id: 'revoked-1', userId, name: 'Old Phone', lastSeen: now, createdAt: now, revokedAt: now },
      ])
      const count = await countActiveDevices(db, userId)
      expect(count).toBe(2)
    })

    it('returns 0 when user has no devices', async () => {
      const count = await countActiveDevices(db, userId)
      expect(count).toBe(0)
    })

    it('does not count devices from other users', async () => {
      const now = new Date()
      const otherUserId = 'other-user-count'
      await db.insert(user).values({
        id: otherUserId,
        name: 'Other User',
        email: 'other-count@test.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      await db.insert(devicesTable).values([
        { id: 'my-device', userId, name: 'Mine', lastSeen: now, createdAt: now },
        { id: 'their-device', userId: otherUserId, name: 'Theirs', lastSeen: now, createdAt: now },
      ])
      const count = await countActiveDevices(db, userId)
      expect(count).toBe(1)
    })
  })
})
