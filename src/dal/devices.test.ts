import { DatabaseSingleton } from '@/db/singleton'
import { devicesTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { getAllDevices, getDevice } from './devices'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Devices DAL', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  describe('getDevice', () => {
    it('returns null when no device with that id', async () => {
      const device = await getDevice('non-existent-id')
      expect(device).toBeNull()
    })

    it('returns device when it exists', async () => {
      const db = DatabaseSingleton.instance.db
      const deviceId = 'device-1'
      const now = new Date().toISOString()

      await db.insert(devicesTable).values({
        id: deviceId,
        userId: 'user-1',
        name: 'Chrome on macOS',
        lastSeen: now,
        createdAt: now,
      })

      const device = await getDevice(deviceId)
      expect(device).not.toBeNull()
      expect(device?.id).toBe(deviceId)
      expect(device?.userId).toBe('user-1')
      expect(device?.name).toBe('Chrome on macOS')
      expect(device?.lastSeen).toBe(now)
      expect(device?.createdAt).toBe(now)
      expect(device?.revokedAt).toBeNull()
    })

    it('returns device with revokedAt when set', async () => {
      const db = DatabaseSingleton.instance.db
      const deviceId = 'device-revoked'
      const now = new Date().toISOString()
      const revokedAt = new Date(Date.now() + 60 * 1000).toISOString()

      await db.insert(devicesTable).values({
        id: deviceId,
        userId: 'user-1',
        name: 'Revoked device',
        lastSeen: now,
        createdAt: now,
        revokedAt,
      })

      const device = await getDevice(deviceId)
      expect(device?.revokedAt).toBe(revokedAt)
    })
  })

  describe('getAllDevices', () => {
    it('returns empty array when no devices', async () => {
      const devices = await getAllDevices()
      expect(devices).toEqual([])
    })

    it('returns all devices ordered by lastSeen desc', async () => {
      const db = DatabaseSingleton.instance.db
      const base = new Date()
      const oldTs = new Date(base.getTime() - 200 * 1000).toISOString()
      const newTs = new Date(base.getTime() + 100 * 1000).toISOString()
      const midTs = new Date(base.getTime() - 50 * 1000).toISOString()

      await db.insert(devicesTable).values([
        {
          id: 'device-old',
          userId: 'user-1',
          name: 'Old device',
          lastSeen: oldTs,
          createdAt: oldTs,
        },
        {
          id: 'device-new',
          userId: 'user-1',
          name: 'New device',
          lastSeen: newTs,
          createdAt: oldTs,
        },
        {
          id: 'device-mid',
          userId: 'user-1',
          name: 'Mid device',
          lastSeen: midTs,
          createdAt: oldTs,
        },
      ])

      const devices = await getAllDevices()
      expect(devices).toHaveLength(3)
      expect(devices[0]?.id).toBe('device-new')
      expect(devices[1]?.id).toBe('device-mid')
      expect(devices[2]?.id).toBe('device-old')
    })
  })
})
