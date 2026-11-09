/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { receivedSharesTable, sentSharesTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { getReceivedShares, getSentShares } from './shares'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

const received = (id: string, updatedAt: string) => ({
  id,
  userId: 'bob',
  ownerUserId: 'alice',
  ownerName: 'Alice',
  ownerEmail: 'alice@example.com',
  encryptedTitle: 'title',
  sealedShareKey: 'key',
  inboxVersion: 1,
  updatedAt,
})

const sent = (id: string, updatedAt: string) => ({
  id,
  userId: 'alice',
  chatThreadId: `thread-${id}`,
  recipients: [{ userId: 'bob', name: 'Bob', email: 'bob@example.com' }],
  version: 1,
  updatedAt,
})

describe('share lists', () => {
  it('lists received shares most recently shared first, ties by id', async () => {
    const db = getDb()
    await db
      .insert(receivedSharesTable)
      .values([
        received('a', '2026-11-08T10:00:00.000Z'),
        received('c', '2026-11-08T12:00:00.000Z'),
        received('b', '2026-11-08T12:00:00.000Z'),
      ])
    expect((await getReceivedShares(db)).map((share) => share.id)).toEqual(['c', 'b', 'a'])
  })

  it('lists sent shares most recently shared first, with their recipients parsed', async () => {
    const db = getDb()
    await db
      .insert(sentSharesTable)
      .values([sent('a', '2026-11-08T10:00:00.000Z'), sent('b', '2026-11-08T12:00:00.000Z')])
    const shares = await getSentShares(db)
    expect(shares.map((share) => share.id)).toEqual(['b', 'a'])
    expect(shares[0]!.recipients).toEqual([{ userId: 'bob', name: 'Bob', email: 'bob@example.com' }])
  })
})
