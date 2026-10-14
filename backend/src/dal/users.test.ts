/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { session, user } from '@/db/auth-schema'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { devicesTable } from '@/db/powersync-schema'
import { createTestDb } from '@/test-utils/db'
import { eq, inArray } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { deleteIdleAnonymousUsers, deleteUser, getUserByEmail, getUserById, markUserNotNew } from './users'

describe('users DAL', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  const insertUser = async (id: string, email: string, isNew = true) => {
    const now = new Date()
    await db.insert(user).values({
      id,
      name: 'Test User',
      email,
      emailVerified: true,
      isNew,
      createdAt: now,
      updatedAt: now,
    })
  }

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  describe('getUserById', () => {
    it('returns user when found', async () => {
      await insertUser('u1', 'u1@test.com')
      const result = await getUserById(db, 'u1')
      expect(result).toEqual({ id: 'u1', isAnonymous: false })
    })

    it('returns null when not found', async () => {
      const result = await getUserById(db, 'nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('getUserByEmail', () => {
    it('returns user when found', async () => {
      await insertUser('u2', 'u2@test.com')
      const result = await getUserByEmail(db, 'u2@test.com')
      expect(result).toEqual({ id: 'u2' })
    })

    it('returns null when not found', async () => {
      const result = await getUserByEmail(db, 'nobody@test.com')
      expect(result).toBeNull()
    })
  })

  describe('deleteUser', () => {
    it('deletes the user', async () => {
      await insertUser('u3', 'u3@test.com')
      await deleteUser(db, 'u3')
      const rows = await db.select().from(user).where(eq(user.id, 'u3'))
      expect(rows).toHaveLength(0)
    })
  })

  describe('deleteIdleAnonymousUsers', () => {
    const dayMs = 24 * 60 * 60 * 1000
    const daysAgo = (days: number) => new Date(Date.now() - days * dayMs)

    const insertAnonymousUser = async (id: string, lastActive: Date, isAnonymous = true) => {
      await db.insert(user).values({
        id,
        name: 'Anonymous',
        email: `temp@${id}.com`,
        isAnonymous,
        createdAt: lastActive,
        updatedAt: lastActive,
      })
    }

    const insertSession = async (userId: string, updatedAt: Date, expiresAt = daysAgo(1)) => {
      await db.insert(session).values({
        id: `session-${userId}`,
        token: `token-${userId}`,
        userId,
        createdAt: updatedAt,
        updatedAt,
        expiresAt,
      })
    }

    const remainingUserIds = async (ids: string[]) =>
      (await db.select({ id: user.id }).from(user).where(inArray(user.id, ids))).map((row) => row.id).sort()

    it('deletes an idle anonymous user with its sessions, devices and usage rows', async () => {
      await insertAnonymousUser('idle', daysAgo(40))
      await insertSession('idle', daysAgo(40))
      await db.insert(devicesTable).values({ id: 'idle-device', userId: 'idle' })
      await db.insert(inferenceUsage).values({
        id: 'idle-usage',
        userId: 'idle',
        provider: 'anthropic',
        model: 'model',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        costNanoUsd: 1n,
        createdAt: daysAgo(40),
      })

      expect(await deleteIdleAnonymousUsers(db, 30)).toBe(1)

      expect(await remainingUserIds(['idle'])).toEqual([])
      expect(await db.select().from(session).where(eq(session.userId, 'idle'))).toHaveLength(0)
      expect(await db.select().from(devicesTable).where(eq(devicesTable.userId, 'idle'))).toHaveLength(0)
      expect(await db.select().from(inferenceUsage).where(eq(inferenceUsage.userId, 'idle'))).toHaveLength(0)
    })

    it('keeps an anonymous user with recent session or usage activity, or an unexpired session', async () => {
      await insertAnonymousUser('recent-session', daysAgo(40))
      await insertSession('recent-session', daysAgo(2))
      await insertAnonymousUser('live-session', daysAgo(40))
      await insertSession('live-session', daysAgo(40), daysAgo(-1))
      await insertAnonymousUser('recent-usage', daysAgo(40))
      await db.insert(inferenceUsage).values({
        id: 'recent-usage-row',
        userId: 'recent-usage',
        provider: 'anthropic',
        model: 'model',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        costNanoUsd: 1n,
        createdAt: daysAgo(2),
      })
      await insertAnonymousUser('recent-user', daysAgo(2))

      expect(await deleteIdleAnonymousUsers(db, 30)).toBe(0)
      expect(await remainingUserIds(['recent-session', 'live-session', 'recent-usage', 'recent-user'])).toEqual([
        'live-session',
        'recent-session',
        'recent-usage',
        'recent-user',
      ])
    })

    it('never deletes a promoted user, however idle', async () => {
      await insertAnonymousUser('promoted', daysAgo(400), false)

      expect(await deleteIdleAnonymousUsers(db, 30)).toBe(0)
      expect(await remainingUserIds(['promoted'])).toEqual(['promoted'])
    })

    it('loops over batches until every idle anonymous user is gone', async () => {
      const ids = ['b1', 'b2', 'b3', 'b4', 'b5']
      for (const id of ids) {
        await insertAnonymousUser(id, daysAgo(40))
      }

      expect(await deleteIdleAnonymousUsers(db, 30, 2)).toBe(5)
      expect(await remainingUserIds(ids)).toEqual([])
    })
  })

  describe('markUserNotNew', () => {
    it('sets isNew to false', async () => {
      await insertUser('u4', 'u4@test.com', true)
      await markUserNotNew(db, 'u4')
      const rows = await db.select().from(user).where(eq(user.id, 'u4'))
      expect(rows[0].isNew).toBe(false)
    })
  })
})
