/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { formatUsageReport, formatUsd, getUsageReport, type UsageReportWindow } from './usage-report'

type TestDatabase = IsolatedTestDb['db']

const userIds = ['anon-1', 'anon-2', 'registered-1']

const festival: UsageReportWindow = {
  from: new Date('2026-10-26T00:00:00Z'),
  to: new Date('2026-11-02T00:00:00Z'),
  timeZone: 'UTC',
}

const insertUser = async (database: TestDatabase, id: string, isAnonymous: boolean) => {
  await database.insert(user).values({
    id,
    name: isAnonymous ? 'Anonymous User' : 'Registered User',
    email: `${id}@example.com`,
    emailVerified: !isAnonymous,
    isAnonymous,
  })
}

const insertTurn = async (
  database: TestDatabase,
  userId: string,
  createdAt: string,
  model = 'accounts/fireworks/models/glm-5p3',
) => {
  await database.insert(inferenceUsage).values({
    id: crypto.randomUUID(),
    userId,
    provider: 'fireworks',
    model,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costNanoUsd: 1_000_000n,
    createdAt: new Date(createdAt),
  })
}

describe('usage report', () => {
  let isolatedDb: IsolatedTestDb
  let database: TestDatabase

  // The report opens its own read-only transaction, which can't nest inside
  // createTestDb's BEGIN/ROLLBACK, so this suite uses the shared isolated
  // connection. The report reads the whole ledger, so each test starts it empty.
  beforeAll(async () => {
    isolatedDb = await getSharedIsolatedTestDb()
    database = isolatedDb.db
  })

  beforeEach(async () => {
    await database.delete(inferenceUsage)
    await insertUser(database, 'anon-1', true)
    await insertUser(database, 'anon-2', true)
    await insertUser(database, 'registered-1', false)
  })

  afterEach(async () => {
    // Cascades to the turns each test recorded.
    await database.delete(user).where(inArray(user.id, userIds))
  })

  it('splits users and turns between anonymous and registered', async () => {
    await insertTurn(database, 'anon-1', '2026-10-27T10:05:00Z')
    await insertTurn(database, 'anon-1', '2026-10-27T10:10:00Z')
    await insertTurn(database, 'anon-2', '2026-10-27T11:00:00Z')
    await insertTurn(database, 'registered-1', '2026-10-28T09:00:00Z')

    const report = await getUsageReport(database, festival)

    expect(report.anonymous).toEqual({
      users: 2,
      turns: 3,
      promptTokens: 300,
      completionTokens: 150,
      costNanoUsd: 3_000_000n,
    })
    expect(report.registered).toEqual({
      users: 1,
      turns: 1,
      promptTokens: 100,
      completionTokens: 50,
      costNanoUsd: 1_000_000n,
    })
    expect(report.all).toEqual({
      users: 3,
      turns: 4,
      promptTokens: 400,
      completionTokens: 200,
      costNanoUsd: 4_000_000n,
    })
  })

  it('includes the start of the window and excludes its end', async () => {
    await insertTurn(database, 'anon-1', '2026-10-26T00:00:00Z')
    await insertTurn(database, 'anon-1', '2026-11-02T00:00:00Z')

    const report = await getUsageReport(database, festival)

    expect(report.all.turns).toBe(1)
  })

  it('draws day buckets in the requested time zone', async () => {
    await insertTurn(database, 'anon-1', '2026-10-26T23:30:00Z')

    const utc = await getUsageReport(database, festival)
    const berlin = await getUsageReport(database, { ...festival, timeZone: 'Europe/Berlin' })

    expect(utc.days.map((row) => row.day)).toEqual(['2026-10-26'])
    expect(berlin.days.map((row) => row.day)).toEqual(['2026-10-27'])
  })

  it('picks the busiest hour by distinct users, not by turns', async () => {
    for (const minute of ['01', '02', '03', '04', '05']) {
      await insertTurn(database, 'anon-1', `2026-10-27T10:${minute}:00Z`)
    }
    await insertTurn(database, 'anon-1', '2026-10-27T14:01:00Z')
    await insertTurn(database, 'anon-2', '2026-10-27T14:02:00Z')
    await insertTurn(database, 'registered-1', '2026-10-27T14:03:00Z')

    const report = await getUsageReport(database, festival)

    expect(report.peakHour).toEqual({ hour: '2026-10-27 14:00 +00:00', users: 3, turns: 3 })
  })

  it('keeps the hour a fall-back repeats as two hours', async () => {
    // London falls back at 01:00 UTC on 25 October, so local 01:00 happens twice.
    await insertTurn(database, 'anon-1', '2026-10-25T00:10:00Z')
    await insertTurn(database, 'anon-2', '2026-10-25T00:20:00Z')
    await insertTurn(database, 'registered-1', '2026-10-25T01:10:00Z')

    const report = await getUsageReport(database, {
      from: new Date('2026-10-25T00:00:00Z'),
      to: new Date('2026-10-26T00:00:00Z'),
      timeZone: 'Europe/London',
    })

    expect(report.peakHour).toEqual({ hour: '2026-10-25 01:00 +01:00', users: 2, turns: 2 })
  })

  it('leaves the connection time zone as it found it', async () => {
    const readTimeZone = async () => (await isolatedDb.client.query('show timezone')).rows
    const before = await readTimeZone()

    await getUsageReport(database, { ...festival, timeZone: 'Europe/Berlin' })

    expect(await readTimeZone()).toEqual(before)
  })

  it('totals each model separately', async () => {
    await insertTurn(database, 'anon-1', '2026-10-27T10:00:00Z')
    await insertTurn(database, 'anon-2', '2026-10-27T10:00:00Z', 'accounts/fireworks/models/minimax-m3')

    const report = await getUsageReport(database, festival)

    expect(report.models.map((row) => [row.model, row.users, row.turns])).toEqual([
      ['accounts/fireworks/models/glm-5p3', 1, 1],
      ['accounts/fireworks/models/minimax-m3', 1, 1],
    ])
  })

  it('reports an empty window as zeros', async () => {
    const report = await getUsageReport(database, festival)

    expect(report.all).toEqual({ users: 0, turns: 0, promptTokens: 0, completionTokens: 0, costNanoUsd: 0n })
    expect(report.days).toEqual([])
    expect(report.models).toEqual([])
    expect(report.peakHour).toBeNull()
    expect(formatUsageReport(report)).toContain('No usage in this window.')
  })

  it('renders the totals, busiest hour, days and models as Markdown', async () => {
    await insertTurn(database, 'anon-1', '2026-10-27T10:05:00Z')
    await insertTurn(database, 'registered-1', '2026-10-27T10:10:00Z')

    const markdown = formatUsageReport(await getUsageReport(database, festival))

    expect(markdown).toContain('| Anonymous | 1 | 1 | 100 | 50 | $0.00 |')
    expect(markdown).toContain('| All | 2 | 2 | 200 | 100 | $0.00 |')
    expect(markdown).toContain('Busiest hour: 2026-10-27 10:00 +00:00, with 2 users and 2 turns.')
    expect(markdown).toContain('| 2026-10-27 | 2 | 2 | $0.00 |')
    expect(markdown).toContain('| fireworks | accounts/fireworks/models/glm-5p3 | 2 | 2 | $0.00 |')
  })
})

describe('formatUsd', () => {
  it('rounds nano-USD down to whole cents', () => {
    expect(formatUsd(1_234_567_890n)).toBe('$1.23')
    expect(formatUsd(9_999_999n)).toBe('$0.00')
    expect(formatUsd(0n)).toBe('$0.00')
  })
})
