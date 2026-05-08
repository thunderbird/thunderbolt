/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-502 regression guard: countActiveDevices only counts trusted, non-revoked devices.
 *
 * Pre-fix bug: the predicate only filtered `revokedAt IS NULL`, so denied/pending devices
 * (especially "limbo" rows from denyDevice() not setting revokedAt) accumulated and consumed
 * slots in the 10-device cap. Post-fix: predicate is `trusted=true AND revokedAt IS NULL`.
 */

import { user } from '@/db/auth-schema'
import { devicesTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { countActiveDevices } from './devices'

type DeviceState = 'trusted' | 'pending' | 'denied' | 'revoked'

const stateColumns = (state: DeviceState, now: Date) => {
  if (state === 'trusted') return { trusted: true, approvalPending: false, revokedAt: null }
  if (state === 'pending') return { trusted: false, approvalPending: true, revokedAt: null }
  if (state === 'denied') return { trusted: false, approvalPending: false, revokedAt: null }
  // revoked
  return { trusted: false, approvalPending: false, revokedAt: now }
}

describe('THU-502: countActiveDevices state characterization', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  const userId = 'thu502-test-user'

  beforeEach(async () => {
    const env = await createTestDb()
    db = env.db
    cleanup = env.cleanup
    const now = new Date()
    await db.insert(user).values({
      id: userId,
      name: 'THU-502 Repro',
      email: 'thu502@test.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  const seedDevices = async (state: DeviceState, n: number) => {
    const now = new Date()
    const cols = stateColumns(state, now)
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `${state}-${i}`,
      userId,
      name: `${state} device ${i}`,
      lastSeen: now,
      createdAt: now,
      ...cols,
    }))
    await db.insert(devicesTable).values(rows)
  }

  it('counts trusted active devices', async () => {
    await seedDevices('trusted', 10)
    expect(await countActiveDevices(db, userId)).toBe(10)
  })

  it('does NOT count pending devices (approvalPending=true)', async () => {
    await seedDevices('pending', 10)
    expect(await countActiveDevices(db, userId)).toBe(0)
  })

  it('does NOT count limbo/denied devices (approvalPending=false, trusted=false, revokedAt=null) — THU-502 regression guard', async () => {
    await seedDevices('denied', 10)
    expect(await countActiveDevices(db, userId)).toBe(0)
  })

  it('does NOT count revoked devices', async () => {
    await seedDevices('revoked', 10)
    expect(await countActiveDevices(db, userId)).toBe(0)
  })

  it('mixed states: only trusted count', async () => {
    await seedDevices('trusted', 2)
    await seedDevices('pending', 3)
    await seedDevices('denied', 4)
    await seedDevices('revoked', 5)
    expect(await countActiveDevices(db, userId)).toBe(2)
  })

  it('10 limbo/denied devices do NOT block new registration after fix', async () => {
    const MAX_DEVICES_PER_USER = 10
    await seedDevices('denied', 10)
    const activeCount = await countActiveDevices(db, userId)
    const limitReached = activeCount >= MAX_DEVICES_PER_USER
    expect(activeCount).toBe(0)
    expect(limitReached).toBe(false)
  })

  it('10 pending devices do NOT block new registration after fix', async () => {
    const MAX_DEVICES_PER_USER = 10
    await seedDevices('pending', 10)
    const activeCount = await countActiveDevices(db, userId)
    const limitReached = activeCount >= MAX_DEVICES_PER_USER
    expect(activeCount).toBe(0)
    expect(limitReached).toBe(false)
  })

  it('only trusted devices count toward the cap', async () => {
    await seedDevices('denied', 5)
    await seedDevices('pending', 4)
    await seedDevices('trusted', 1)
    expect(await countActiveDevices(db, userId)).toBe(1)
  })
})
