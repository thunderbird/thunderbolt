/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { devicesTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { eq, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  countActiveDevices,
  denyDevice,
  getDeviceById,
  getTrustedNodeIds,
  isCliDeviceId,
  markDeviceTrusted,
  registerDevice,
  revokeDevice,
  setDeviceNodeId,
  upsertCliDevice,
  upsertDevice,
  withUserDeviceRegistrationLock,
} from './devices'

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
    if (cleanup) {
      await cleanup()
    }
  })

  describe('withUserDeviceRegistrationLock', () => {
    it('awaits the account advisory lock before starting device-cap decisions', async () => {
      const queryObserved = Promise.withResolvers<SQL>()
      const releaseExecute = Promise.withResolvers<void>()
      const events: string[] = []
      const executor = new Proxy(db, {
        get: (_target, property) => {
          if (property !== 'execute') {
            throw new Error(`Unexpected database property: ${String(property)}`)
          }
          return (query: SQL) => {
            queryObserved.resolve(query)
            return releaseExecute.promise
          }
        },
      })

      const registration = withUserDeviceRegistrationLock(executor, userId, async () => {
        events.push('started')
        return 'registered'
      })
      const query = await queryObserved.promise
      const compiled = new PgDialect().sqlToQuery(query)

      expect(compiled.sql).toBe('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)')
      expect(compiled.params).toEqual([userId])
      await Promise.resolve()
      expect(events).toEqual([])
      releaseExecute.resolve()
      expect(await registration).toBe('registered')
      expect(events).toEqual(['started'])
    })
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

  describe('CLI devices', () => {
    it('accepts only cli- followed by a canonical lowercase UUID', () => {
      expect(isCliDeviceId('cli-019f0000-0000-7000-8000-000000000001')).toBe(true)
      expect(isCliDeviceId('cli-019F0000-0000-7000-8000-000000000001')).toBe(false)
      expect(isCliDeviceId('cli-not-a-uuid')).toBe(false)
      expect(isCliDeviceId('019f0000-0000-7000-8000-000000000001')).toBe(false)
    })

    it('creates an exact server-owned CLI row and only touches mutable metadata on repeat registration', async () => {
      const createdAt = new Date('2026-08-27T10:00:00.000Z')
      const later = new Date('2026-08-27T11:00:00.000Z')
      const id = 'cli-019f0000-0000-7000-8000-000000000001'

      const inserted = await upsertCliDevice(db, {
        id,
        userId,
        name: 'Thunderbolt CLI',
        appVersion: '1.0.0',
        lastSeen: createdAt,
        createdAt,
      })
      expect(inserted).toHaveLength(1)
      expect(inserted[0]).toMatchObject({
        id,
        userId,
        name: 'Thunderbolt CLI',
        appVersion: '1.0.0',
        deviceType: 'cli',
        trusted: true,
        approvalPending: false,
        publicKey: null,
        mlkemPublicKey: null,
        nodeId: null,
        nodeIdAttestedAt: null,
        revokedAt: null,
        createdAt,
        lastSeen: createdAt,
      })

      const touched = await upsertCliDevice(db, {
        id,
        userId,
        name: 'Renamed CLI',
        appVersion: '1.1.0',
        lastSeen: later,
        createdAt: later,
      })
      expect(touched).toHaveLength(1)
      expect(touched[0]).toMatchObject({
        name: 'Renamed CLI',
        appVersion: '1.1.0',
        createdAt,
        lastSeen: later,
        deviceType: 'cli',
        trusted: true,
        approvalPending: false,
      })
    })

    it('does not overwrite a colliding normal row or another user row', async () => {
      const now = new Date()
      const otherUserId = 'cli-collision-other-user'
      await db.insert(user).values({
        id: otherUserId,
        name: 'Other User',
        email: 'cli-collision@test.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      const sameUserCollision = 'cli-019f0000-0000-7000-8000-000000000002'
      const otherUserCollision = 'cli-019f0000-0000-7000-8000-000000000003'
      await db.insert(devicesTable).values([
        { id: sameUserCollision, userId, name: 'Normal', deviceType: 'normal', lastSeen: now, createdAt: now },
        {
          id: otherUserCollision,
          userId: otherUserId,
          name: 'Other CLI',
          deviceType: 'cli',
          trusted: true,
          lastSeen: now,
          createdAt: now,
        },
      ])

      expect(
        await upsertCliDevice(db, {
          id: sameUserCollision,
          userId,
          name: 'Attempted Conversion',
          appVersion: '1.0.0',
          lastSeen: now,
          createdAt: now,
        }),
      ).toEqual([])
      expect(
        await upsertCliDevice(db, {
          id: otherUserCollision,
          userId,
          name: 'Attempted Takeover',
          appVersion: '1.0.0',
          lastSeen: now,
          createdAt: now,
        }),
      ).toEqual([])

      expect((await db.select().from(devicesTable).where(eq(devicesTable.id, sameUserCollision)))[0]).toMatchObject({
        userId,
        name: 'Normal',
        deviceType: 'normal',
      })
      expect((await db.select().from(devicesTable).where(eq(devicesTable.id, otherUserCollision)))[0]).toMatchObject({
        userId: otherUserId,
        name: 'Other CLI',
      })
    })

    it('does not resurrect a revoked CLI tombstone', async () => {
      const now = new Date()
      const id = 'cli-019f0000-0000-7000-8000-000000000004'
      await db.insert(devicesTable).values({
        id,
        userId,
        name: 'Revoked CLI',
        deviceType: 'cli',
        trusted: false,
        revokedAt: now,
        lastSeen: now,
        createdAt: now,
      })

      expect(
        await upsertCliDevice(db, {
          id,
          userId,
          name: 'Resurrection Attempt',
          appVersion: '1.0.0',
          lastSeen: new Date(now.getTime() + 60_000),
          createdAt: new Date(now.getTime() + 60_000),
        }),
      ).toEqual([])
      const [persisted] = await db.select().from(devicesTable).where(eq(devicesTable.id, id))
      expect(persisted.name).toBe('Revoked CLI')
      expect(persisted.revokedAt).toEqual(now)
      expect(persisted.trusted).toBe(false)
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

    it('clears the iroh node binding so a revoked endpoint stops syncing', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({
        id: 'd6',
        userId,
        name: 'Bound Laptop',
        lastSeen: now,
        createdAt: now,
        trusted: true,
        nodeId: 'node-abc',
        nodeIdAttestedAt: now,
      })
      await revokeDevice(db, 'd6', userId)
      const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, 'd6'))
      expect(rows[0].revokedAt).not.toBeNull()
      expect(rows[0].nodeId).toBeNull()
      expect(rows[0].nodeIdAttestedAt).toBeNull()
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

    it('clears the stale iroh node binding on deny, mirroring revoke', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({
        id: 'd-deny-node',
        userId,
        name: 'Pending Bound',
        approvalPending: true,
        nodeId: 'stale-deny-node',
        nodeIdAttestedAt: now,
        lastSeen: now,
        createdAt: now,
      })
      const rows = await denyDevice(db, 'd-deny-node', userId)
      expect(rows[0].approvalPending).toBe(false)
      expect(rows[0].nodeId).toBeNull()
      expect(rows[0].nodeIdAttestedAt).toBeNull()
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

  describe('setDeviceNodeId', () => {
    const seedDevice = (over: Record<string, unknown>) =>
      db
        .insert(devicesTable)
        .values({ id: 'd-bind', userId, name: 'Bind', lastSeen: new Date(), createdAt: new Date(), ...over })

    it('binds a node_id on a trusted device', async () => {
      await seedDevice({ trusted: true, approvalPending: false })
      const rows = await setDeviceNodeId(db, 'd-bind', userId, 'node-trusted')
      expect(rows[0].nodeId).toBe('node-trusted')
      expect(rows[0].nodeIdAttestedAt).not.toBeNull()
    })

    it('binds a node_id on a pending device (attestation during pairing)', async () => {
      await seedDevice({ trusted: false, approvalPending: true })
      const rows = await setDeviceNodeId(db, 'd-bind', userId, 'node-pending')
      expect(rows[0].nodeId).toBe('node-pending')
    })

    it('refuses to (re-)bind a DENIED device so a denied peer cannot restore its P2P binding', async () => {
      // The state denyDevice leaves: trusted=false, approvalPending=false, revokedAt=null.
      await seedDevice({ trusted: false, approvalPending: false })
      const rows = await setDeviceNodeId(db, 'd-bind', userId, 'node-denied')
      expect(rows).toHaveLength(0)
    })

    it('refuses to bind a revoked device', async () => {
      await seedDevice({ trusted: true, approvalPending: false, revokedAt: new Date() })
      const rows = await setDeviceNodeId(db, 'd-bind', userId, 'node-revoked')
      expect(rows).toHaveLength(0)
    })

    it('refuses to bind a CLI device into the iroh identity path', async () => {
      await seedDevice({ deviceType: 'cli', trusted: true, approvalPending: false })
      const rows = await setDeviceNodeId(db, 'd-bind', userId, 'node-cli')
      expect(rows).toHaveLength(0)
    })
  })

  describe('getTrustedNodeIds', () => {
    const seed = (
      id: string,
      nodeId: string | null,
      over: {
        trusted?: boolean
        approvalPending?: boolean
        revokedAt?: Date
        deviceType?: 'normal' | 'bridge' | 'cli'
      } = {},
      forUserId = userId,
    ) => {
      const now = new Date()
      const { trusted = true, approvalPending = !trusted, revokedAt, deviceType = 'normal' } = over
      return db.insert(devicesTable).values({
        id,
        userId: forUserId,
        name: id,
        trusted,
        approvalPending,
        deviceType,
        lastSeen: now,
        createdAt: now,
        ...(nodeId ? { nodeId, nodeIdAttestedAt: now } : {}),
        ...(revokedAt ? { revokedAt } : {}),
      })
    }

    it('returns node_id + device_type for trusted, non-revoked, bound devices only', async () => {
      await seed('tn-trusted', 'node-a', { deviceType: 'normal' })
      await seed('tn-bridge', 'node-b', { deviceType: 'bridge' })
      await seed('tn-cli', 'node-cli', { deviceType: 'cli' })
      await seed('tn-pending', 'node-c', { trusted: false })
      await seed('tn-revoked', 'node-d', { trusted: true, revokedAt: new Date() })
      await seed('tn-nonode', null, { trusted: true })

      const rows = await getTrustedNodeIds(db, userId)
      const byNode = Object.fromEntries(rows.map((r) => [r.nodeId, r.deviceType]))
      expect(Object.keys(byNode).sort()).toEqual(['node-a', 'node-b'])
      expect(byNode['node-b']).toBe('bridge')
    })

    it('is scoped to the user and never returns another account rows', async () => {
      const now = new Date()
      const otherUserId = 'other-user-nodeids'
      await db.insert(user).values({
        id: otherUserId,
        name: 'Other',
        email: 'other-nodeids@test.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      await seed('tn-mine', 'node-mine')
      await seed('tn-theirs', 'node-theirs', {}, otherUserId)

      const rows = await getTrustedNodeIds(db, userId)
      expect(rows.map((r) => r.nodeId)).toEqual(['node-mine'])
    })

    it('returns an empty array when no trusted bound devices exist', async () => {
      const rows = await getTrustedNodeIds(db, userId)
      expect(rows).toEqual([])
    })
  })

  describe('registerDevice', () => {
    it('clears the stale iroh node binding on re-registration, mirroring revoke', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({
        id: 'd-reg-rebind',
        userId,
        name: 'Old Bound',
        trusted: true,
        approvalPending: false,
        publicKey: 'old-pk',
        mlkemPublicKey: 'old-mlkem',
        nodeId: 'stale-node-id',
        nodeIdAttestedAt: now,
        lastSeen: now,
        createdAt: now,
      })
      const rows = await registerDevice(db, {
        id: 'd-reg-rebind',
        userId,
        name: 'Old Bound',
        publicKey: 'new-pk',
        mlkemPublicKey: 'new-mlkem',
      })
      expect(rows[0].trusted).toBe(false)
      expect(rows[0].approvalPending).toBe(true)
      expect(rows[0].publicKey).toBe('new-pk')
      expect(rows[0].nodeId).toBeNull()
      expect(rows[0].nodeIdAttestedAt).toBeNull()
    })

    it('does not convert an existing CLI row into a normal encryption device', async () => {
      const now = new Date()
      const id = 'cli-019f0000-0000-7000-8000-000000000005'
      await db.insert(devicesTable).values({
        id,
        userId,
        name: 'CLI',
        trusted: true,
        deviceType: 'cli',
        lastSeen: now,
        createdAt: now,
      })

      expect(
        await registerDevice(db, {
          id,
          userId,
          name: 'Encryption Attempt',
          publicKey: 'pk',
          mlkemPublicKey: 'mlkem',
        }),
      ).toEqual([])
      const [persisted] = await db.select().from(devicesTable).where(eq(devicesTable.id, id))
      expect(persisted).toMatchObject({ deviceType: 'cli', publicKey: null, mlkemPublicKey: null, trusted: true })
    })

    it('does not update a revoked normal device during a stale registration race', async () => {
      const now = new Date()
      const id = 'd-reg-revoked-race'
      await db.insert(devicesTable).values({
        id,
        userId,
        name: 'Revoked Normal',
        trusted: false,
        approvalPending: false,
        publicKey: 'old-pk',
        mlkemPublicKey: 'old-mlkem',
        revokedAt: now,
        lastSeen: now,
        createdAt: now,
      })

      expect(
        await registerDevice(db, {
          id,
          userId,
          name: 'Re-registration Attempt',
          publicKey: 'new-pk',
          mlkemPublicKey: 'new-mlkem',
        }),
      ).toEqual([])
      const [persisted] = await db.select().from(devicesTable).where(eq(devicesTable.id, id))
      expect(persisted).toMatchObject({
        publicKey: 'old-pk',
        mlkemPublicKey: 'old-mlkem',
        revokedAt: now,
        approvalPending: false,
      })
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
