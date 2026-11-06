/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import { account, session, user } from '@/db/auth-schema'
import { betterAuthTestSecret } from '@/test-utils/auth-token'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { createAuth } from './auth'

describe('joined auth identity lookup', () => {
  let db: IsolatedTestDb['db']
  let adapter: Awaited<ReturnType<typeof createAuth>['$context']>['internalAdapter']
  let settingsSpy: ReturnType<typeof spyOn<typeof settingsModule, 'getSettings'>>
  let userIds: string[]
  let accountIds: string[]
  let providerId: string
  let subject: string

  beforeAll(async () => {
    const isolated = await getSharedIsolatedTestDb()
    db = isolated.db
  }, 60_000)

  beforeEach(async () => {
    settingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(
      createTestSettings({ betterAuthSecret: betterAuthTestSecret, posthogHost: '' }),
    )
    adapter = (await createAuth(db).$context).internalAdapter
    userIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    accountIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    providerId = crypto.randomUUID()
    subject = crypto.randomUUID()
    await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.com` })))
    await db.insert(account).values([
      {
        id: accountIds[0],
        providerId,
        accountId: subject,
        userId: userIds[0],
        updatedAt: new Date(),
      },
      {
        id: accountIds[1],
        providerId: `${providerId}-other`,
        accountId: subject,
        userId: userIds[1],
        updatedAt: new Date(),
      },
      {
        id: accountIds[2],
        providerId,
        accountId: `${subject}-other`,
        userId: userIds[2],
        updatedAt: new Date(),
      },
    ])
  })

  afterEach(async () => {
    try {
      // Cascades remove only this test's accounts and sessions.
      await db.delete(user).where(inArray(user.id, userIds))
    } finally {
      settingsSpy.mockRestore()
    }
  })

  it('matches both provider and subject without falling back to another identity', async () => {
    const owner = await adapter.findAccountOwnerByKey({ providerId, accountId: subject })

    expect(owner).toMatchObject({
      kind: 'owned',
      user: { id: userIds[0] },
      account: { id: accountIds[0], userId: userIds[0] },
    })
    expect(await adapter.findAccountOwnerByKey({ providerId: `${providerId}-missing`, accountId: subject })).toBeNull()
    expect(await adapter.findAccountOwnerByKey({ providerId, accountId: `${subject}-missing` })).toBeNull()
  })

  it('joins only accounts belonging to the requested user', async () => {
    const result = await adapter.findUserByEmail(`${userIds[0]}@example.com`, { includeAccounts: true })

    expect(result?.user.id).toBe(userIds[0])
    expect(result?.accounts.map((entry) => entry.id)).toEqual([accountIds[0]])
  })

  it('rejects duplicate owners of the same provider and subject', async () => {
    await db.insert(account).values({
      id: crypto.randomUUID(),
      providerId,
      accountId: subject,
      userId: userIds[1],
      updatedAt: new Date(),
    })

    await expect(adapter.findAccountOwnerByKey({ providerId, accountId: subject })).rejects.toThrow(
      'Multiple accounts match',
    )
  })

  it('keeps bulk session owners separate and excludes expired and unknown tokens', async () => {
    const tokens = userIds.map(() => crypto.randomUUID())
    await db.insert(session).values(
      userIds.map((userId, index) => ({
        id: crypto.randomUUID(),
        userId,
        token: tokens[index],
        updatedAt: new Date(),
        expiresAt: new Date(index === 1 ? 0 : Date.now() + 60_000),
      })),
    )

    const active = await adapter.findSessions(tokens, { onlyActiveSessions: true })

    expect(active).toHaveLength(2)
    for (const index of [0, 2]) {
      expect(active).toContainEqual(
        expect.objectContaining({
          user: expect.objectContaining({ id: userIds[index] }),
          session: expect.objectContaining({ userId: userIds[index], token: tokens[index] }),
        }),
      )
    }
    expect(await adapter.findSessions([crypto.randomUUID()], { onlyActiveSessions: true })).toEqual([])
  })
})
