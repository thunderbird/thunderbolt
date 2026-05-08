/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { devicesTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { countActiveDevices, denyDevice, getDeviceById, markDeviceTrusted, revokeDevice, upsertDevice } from './devices'

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
    it('counts trusted, non-revoked devices for user', async () => {
      const now = new Date()
      await db.insert(devicesTable).values([
        { id: 'active-1', userId, name: 'Phone', trusted: true, lastSeen: now, createdAt: now },
        { id: 'active-2', userId, name: 'Laptop', trusted: true, lastSeen: now, createdAt: now },
        { id: 'revoked-1', userId, name: 'Old Phone', lastSeen: now, createdAt: now, revokedAt: now },
      ])
      const count = await countActiveDevices(db, userId)
      expect(count).toBe(2)
    })

    it('returns 0 when user has no devices', async () => {
      const count = await countActiveDevices(db, userId)
      expect(count).toBe(0)
    })

    it('does not count pending or limbo devices (THU-502)', async () => {
      const now = new Date()
      await db.insert(devicesTable).values([
        { id: 'trusted-1', userId, name: 'Trusted', trusted: true, lastSeen: now, createdAt: now },
        { id: 'pending-1', userId, name: 'Pending', approvalPending: true, lastSeen: now, createdAt: now },
        { id: 'limbo-1', userId, name: 'Limbo', lastSeen: now, createdAt: now },
      ])
      const count = await countActiveDevices(db, userId)
      expect(count).toBe(1)
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
        { id: 'my-device', userId, name: 'Mine', trusted: true, lastSeen: now, createdAt: now },
        { id: 'their-device', userId: otherUserId, name: 'Theirs', trusted: true, lastSeen: now, createdAt: now },
      ])
      const count = await countActiveDevices(db, userId)
      expect(count).toBe(1)
    })
  })

  describe('denyDevice', () => {
    it('clears approvalPending without setting revokedAt so the device can re-register', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({
        id: 'd-deny-1',
        userId,
        name: 'Pending',
        approvalPending: true,
        lastSeen: now,
        createdAt: now,
      })
      await denyDevice(db, 'd-deny-1', userId)
      const row = await getDeviceById(db, 'd-deny-1')
      expect(row!.approvalPending).toBe(false)
      expect(row!.trusted).toBe(false)
      expect(row!.revokedAt).toBeNull()
    })

    it('is a no-op on a trusted device (TOCTOU race guard)', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({
        id: 'd-deny-trusted',
        userId,
        name: 'Trusted',
        trusted: true,
        approvalPending: false,
        lastSeen: now,
        createdAt: now,
      })
      const rows = await denyDevice(db, 'd-deny-trusted', userId)
      expect(rows).toHaveLength(0)
      const row = await getDeviceById(db, 'd-deny-trusted')
      expect(row!.trusted).toBe(true)
      expect(row!.revokedAt).toBeNull()
    })

    it('does not deny a device for the wrong user', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({
        id: 'd-deny-wrong-user',
        userId,
        name: 'Pending',
        approvalPending: true,
        lastSeen: now,
        createdAt: now,
      })
      const rows = await denyDevice(db, 'd-deny-wrong-user', 'other-user')
      expect(rows).toHaveLength(0)
      const row = await getDeviceById(db, 'd-deny-wrong-user')
      expect(row!.approvalPending).toBe(true)
    })

    it('does not revoke a concurrently-approved device (Finding A regression)', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({
        id: 'd-race',
        userId,
        name: 'Pending',
        trusted: false,
        approvalPending: true,
        lastSeen: now,
        createdAt: now,
      })
      // Simulate the race: markDeviceTrusted lands first, then denyDevice's UPDATE arrives
      await markDeviceTrusted(db, 'd-race', userId)
      await denyDevice(db, 'd-race', userId)
      const row = await getDeviceById(db, 'd-race')
      expect(row!.trusted).toBe(true)
      expect(row!.revokedAt).toBeNull()
    })
  })

  describe('markDeviceTrusted', () => {
    it('returns updated row when device is not revoked', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({
        id: 'd-mt-1',
        userId,
        name: 'Pending',
        approvalPending: true,
        lastSeen: now,
        createdAt: now,
      })
      const rows = await markDeviceTrusted(db, 'd-mt-1', userId)
      expect(rows).toHaveLength(1)
      expect(rows[0].trusted).toBe(true)
      expect(rows[0].approvalPending).toBe(false)
    })

    it('returns empty array when device was revoked (Finding D)', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({
        id: 'd-mt-revoked',
        userId,
        name: 'Revoked',
        approvalPending: true,
        revokedAt: now,
        lastSeen: now,
        createdAt: now,
      })
      // Simulate concurrent revoke landing between in-tx target read and this UPDATE:
      // markDeviceTrusted must not silently succeed on a revoked device.
      const rows = await markDeviceTrusted(db, 'd-mt-revoked', userId)
      expect(rows).toHaveLength(0)
      const row = await getDeviceById(db, 'd-mt-revoked')
      expect(row!.trusted).toBe(false)
      expect(row!.revokedAt).not.toBeNull()
    })

    it('returns empty array for wrong user', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({
        id: 'd-mt-wrong-user',
        userId,
        name: 'Pending',
        approvalPending: true,
        lastSeen: now,
        createdAt: now,
      })
      const rows = await markDeviceTrusted(db, 'd-mt-wrong-user', 'other-user')
      expect(rows).toHaveLength(0)
      const row = await getDeviceById(db, 'd-mt-wrong-user')
      expect(row!.trusted).toBe(false)
    })

    it('is a no-op when device was concurrently denied (Finding E)', async () => {
      const now = new Date()
      // Device in (trusted=false, approvalPending=false, revokedAt=null) — the state denyDevice
      // leaves it in. If markDeviceTrusted runs after denyDevice committed, it must not silently
      // promote the denied device.
      await db.insert(devicesTable).values({
        id: 'd-mt-denied',
        userId,
        name: 'Denied',
        trusted: false,
        approvalPending: false,
        lastSeen: now,
        createdAt: now,
      })
      const rows = await markDeviceTrusted(db, 'd-mt-denied', userId)
      expect(rows).toHaveLength(0)
      const row = await getDeviceById(db, 'd-mt-denied')
      expect(row!.trusted).toBe(false)
      expect(row!.approvalPending).toBe(false)
      expect(row!.revokedAt).toBeNull()
    })
  })
})
