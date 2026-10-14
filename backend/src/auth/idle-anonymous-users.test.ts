/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import type { QueryableDatabase } from '@/db/client'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sweepIdleAnonymousUsers } from './idle-anonymous-users'

describe('sweepIdleAnonymousUsers', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let logs: { level: 'info' | 'error'; context: Record<string, unknown>; message: string }[]

  const log = {
    info: (context: Record<string, unknown>, message: string) => logs.push({ level: 'info', context, message }),
    error: (context: Record<string, unknown>, message: string) => logs.push({ level: 'error', context, message }),
  }

  const insertIdleAnonymousUser = async () => {
    const lastActive = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await db.insert(user).values({
      id: 'idle',
      name: 'Anonymous',
      email: 'temp@idle.com',
      isAnonymous: true,
      createdAt: lastActive,
      updatedAt: lastActive,
    })
  }

  const idleUserExists = async () => (await db.select().from(user).where(eq(user.id, 'idle'))).length > 0

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    logs = []
  })

  afterEach(async () => {
    await cleanup()
  })

  it('purges idle anonymous users and logs the count', async () => {
    await insertIdleAnonymousUser()

    await sweepIdleAnonymousUsers(db, { authAllowAnonymous: true, anonymousUserIdleDays: 30 }, log)

    expect(await idleUserExists()).toBe(false)
    expect(logs).toEqual([{ level: 'info', context: { deleted: 1 }, message: 'Purged idle anonymous users' }])
  })

  it('does nothing when ANONYMOUS_USER_IDLE_DAYS is 0', async () => {
    await insertIdleAnonymousUser()

    await sweepIdleAnonymousUsers(db, { authAllowAnonymous: true, anonymousUserIdleDays: 0 }, log)

    expect(await idleUserExists()).toBe(true)
  })

  it('does nothing when anonymous sign-in is off', async () => {
    await insertIdleAnonymousUser()

    await sweepIdleAnonymousUsers(db, { authAllowAnonymous: false, anonymousUserIdleDays: 30 }, log)

    expect(await idleUserExists()).toBe(true)
  })

  it('logs and resolves when the delete throws', async () => {
    const err = new Error('database unavailable')
    const failingDb = {
      select: db.select.bind(db),
      delete: () => {
        throw err
      },
    } as unknown as QueryableDatabase

    await sweepIdleAnonymousUsers(failingDb, { authAllowAnonymous: true, anonymousUserIdleDays: 30 }, log)

    expect(logs).toEqual([{ level: 'error', context: { err }, message: 'Failed to sweep idle anonymous users' }])
  })
})
