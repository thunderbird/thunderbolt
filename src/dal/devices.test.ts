/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
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
    it('returns undefined when no device with that id', async () => {
      const device = await getDevice(getDb(), 'non-existent-id').get()
      expect(device).toBeUndefined()
    })

    it('returns device when it exists', async () => {
      const db = getDb()
      const deviceId = 'device-1'
      const now = new Date().toISOString()

      await db.insert(devicesTable).values({
        id: deviceId,
        userId: 'user-1',
        name: 'Chrome on macOS',
        lastSeen: now,
        createdAt: now,
      })

      const device = await getDevice(getDb(), deviceId).get()
      expect(device).not.toBeUndefined()
      expect(device?.id).toBe(deviceId)
      expect(device?.userId).toBe('user-1')
      expect(device?.name).toBe('Chrome on macOS')
      expect(device?.lastSeen).toBe(now)
      expect(device?.createdAt).toBe(now)
      expect(device?.revokedAt).toBeNull()
    })

    it('returns device with revokedAt when set', async () => {
      const db = getDb()
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

      const device = await getDevice(getDb(), deviceId).get()
      expect(device?.revokedAt).toBe(revokedAt)
    })
  })

  describe('getAllDevices', () => {
    it('returns empty array when no devices', async () => {
      const devices = await getAllDevices(getDb())
      expect(devices).toEqual([])
    })

    it('returns all devices ordered by lastSeen desc', async () => {
      const db = getDb()
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

      const devices = await getAllDevices(getDb())
      expect(devices).toHaveLength(3)
      expect(devices[0]?.id).toBe('device-new')
      expect(devices[1]?.id).toBe('device-mid')
      expect(devices[2]?.id).toBe('device-old')
    })
  })
})
