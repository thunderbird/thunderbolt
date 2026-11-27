/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-disable no-console -- The measurements this suite prints are its output. */

import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { clearSettingsCache } from '@/config/settings'
import { auditEvent, membershipSource, orgMembership, scimGroupMember, scimUser } from '@/db/schema'
import { insertTestUsers } from '@/test-utils/identity'
import { createPostgresTestDb, postgresTestUrl } from '@/test-utils/postgres'
import { createScimClient, entraUser, type ScimClient, scimGroupSchema, uniqueSuffix } from '@/test-utils/scim'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { createScimConnection } from './connections'

/*
 * An IdP's initial sync of thousands of users on Postgres, and a second pass of the same sync.
 * Local only: it takes minutes, so it runs when SCIM_LOAD_USERS is set (`bun run test:scim-load`).
 * It prints what it measured; the asserts are that nothing is lost, duplicated or replayed.
 */
const userCount = Number(process.env.SCIM_LOAD_USERS ?? 0)
/** With SCIM_LOAD_BUDGET=1 the per-credential budget applies, and the sync waits out its 429s. */
const withBudget = process.env.SCIM_LOAD_BUDGET === '1'
const concurrency = Number(process.env.SCIM_LOAD_CONCURRENCY ?? 16)
const groupSize = 100
const memberBatch = 25
const workerCount = 4

type Timing = { operation: string; ms: number; status: number }

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]

/** Run `jobs` with at most `limit` in flight, as an IdP's provisioning worker pool does. */
const inPool = async <T>(jobs: (() => Promise<T>)[], limit: number) => {
  const results: T[] = []
  let next = 0
  const lane = async () => {
    while (next < jobs.length) {
      const index = next++
      results[index] = await jobs[index]()
    }
  }
  await Promise.all(Array.from({ length: limit }, lane))
  return results
}

const summarize = (label: string, timings: Timing[], wallMs: number) => {
  const byOperation = Map.groupBy(timings, (timing) => timing.operation)
  const rows = [...byOperation].map(([operation, entries]) => {
    const sorted = entries.map((entry) => entry.ms).sort((a, b) => a - b)
    return {
      operation,
      requests: entries.length,
      p50: Math.round(percentile(sorted, 0.5)),
      p95: Math.round(percentile(sorted, 0.95)),
      p99: Math.round(percentile(sorted, 0.99)),
      max: Math.round(sorted.at(-1)!),
      non2xx: entries.filter((entry) => entry.status >= 300).length,
    }
  })
  console.log(
    `\n${label}: ${timings.length} requests in ${(wallMs / 1000).toFixed(1)} s ` +
      `(${Math.round(timings.length / (wallMs / 1000))} req/s), ${workerCount} workers, concurrency ${concurrency}, ` +
      `SCIM budget ${withBudget ? 'on' : 'off'}`,
  )
  console.table(rows)
}

describe.skipIf(!postgresTestUrl || !userCount)(`initial SCIM sync of ${userCount} users on Postgres`, () => {
  let close: () => Promise<void>
  let db: Awaited<ReturnType<typeof createPostgresTestDb>>['db']
  let workers: ScimClient
  let connectionId: string
  let scimConnectionId: string
  const timings: Timing[] = []
  const users = Array.from({ length: userCount }, (_, index) => ({
    externalId: crypto.randomUUID(),
    userName: `load-${index}-${uniqueSuffix()}@load.example`,
  }))
  const scimIds = new Map<string, string>()
  let peakConnections = 0
  /** Requests the per-credential budget refused and that were sent again. */
  let throttled = 0

  beforeAll(async () => {
    if (withBudget) {
      // The test preload turns rate limiting off for every suite; this one measures it.
      process.env.RATE_LIMIT_ENABLED = 'true'
      clearSettingsCache()
    }
    const testDb = await createPostgresTestDb()
    ;({ db, close } = testDb)
    const apps = Array.from({ length: workerCount }, () =>
      new Elysia({ prefix: '/v1' }).use(createBetterAuthPlugin(db).plugin),
    )
    const actorId = `load-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
    const created = await createScimConnection(createBetterAuthPlugin(db).auth, { actorId, name: 'Load' })
    connectionId = created.connection.id
    scimConnectionId = created.connection.scimConnectionId!
    let turn = 0
    workers = createScimClient((request) => apps[turn++ % apps.length].handle(request), created.token)
  }, 60_000)

  afterAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'false'
    clearSettingsCache()
    await close?.()
  })

  /** Send and time a request. A 429 is waited out and sent again after its Retry-After, as an IdP does. */
  const timed = async (
    operation: string,
    send: () => ReturnType<ScimClient['call']>,
  ): ReturnType<ScimClient['call']> => {
    const start = performance.now()
    const result = await send()
    if (result.status === 429) {
      const retryAfter = result.headers.get('retry-after')
      expect(retryAfter).toMatch(/^\d+$/)
      throttled++
      await Bun.sleep(Number(retryAfter) * 1000)
      return timed(operation, send)
    }
    timings.push({ operation, ms: performance.now() - start, status: result.status })
    return result
  }

  const lookUp = (externalId: string) =>
    timed('GET filter', () =>
      workers.call('GET', `/Users?filter=${encodeURIComponent(`externalId eq "${externalId}"`)}`),
    )

  it(
    'provisions every user and group membership once, with no request left failing',
    async () => {
      const sampler = setInterval(async () => {
        const [row] = (await db.execute(
          sql`select count(*)::int as connections from pg_stat_activity where datname = current_database()`,
        )) as unknown as { connections: number }[]
        peakConnections = Math.max(peakConnections, row.connections)
      }, 250)
      const start = performance.now()
      await inPool(
        users.map((user) => async () => {
          await lookUp(user.externalId)
          const created = await timed('POST /Users', () =>
            workers.call('POST', '/Users', { body: entraUser(user.userName, user.externalId) }),
          )
          scimIds.set(user.externalId, created.body.id!)
        }),
        concurrency,
      )
      const groups = await inPool(
        Array.from({ length: Math.ceil(userCount / groupSize) }, (_, index) => async () => {
          const created = await timed('POST /Groups', () =>
            workers.call('POST', '/Groups', { body: { schemas: [scimGroupSchema], displayName: `Load ${index}` } }),
          )
          const members = users.slice(index * groupSize, (index + 1) * groupSize)
          for (let offset = 0; offset < members.length; offset += memberBatch) {
            const value = members
              .slice(offset, offset + memberBatch)
              .map((user) => ({ value: scimIds.get(user.externalId) }))
            await timed('PATCH add members', () =>
              workers.patch(`/Groups/${created.body.id}`, [{ op: 'add', path: 'members', value }]),
            )
          }
          return created.body.id!
        }),
        concurrency,
      )
      summarize('Initial sync', timings, performance.now() - start)
      clearInterval(sampler)
      console.log(`Refused by the SCIM budget and sent again: ${throttled}`)

      expect(timings.filter((timing) => timing.status >= 300)).toEqual([])
      expect(await db.$count(scimUser, eq(scimUser.connectionId, scimConnectionId))).toBe(userCount)
      expect(await db.$count(membershipSource, eq(membershipSource.identityConnectionId, connectionId))).toBe(userCount)
      expect(await db.$count(orgMembership)).toBe(userCount + 1)
      expect(
        await db.$count(
          auditEvent,
          and(eq(auditEvent.action, 'scim.user_created'), eq(auditEvent.connectionId, connectionId)),
        ),
      ).toBe(userCount)
      expect(await db.$count(scimGroupMember, inArray(scimGroupMember.groupId, groups))).toBe(userCount)
      console.log(`Peak Postgres connections during the sync: ${peakConnections}`)
    },
    60 * 60_000,
  )

  it(
    'writes nothing when the same sync runs again',
    async () => {
      timings.length = 0
      const eventsBefore = await db.$count(auditEvent)
      const start = performance.now()
      await inPool(
        users.map((user) => async () => {
          await lookUp(user.externalId)
          await timed('PATCH no-op', () =>
            workers.patch(`/Users/${scimIds.get(user.externalId)}`, [{ op: 'replace', path: 'active', value: true }]),
          )
        }),
        concurrency,
      )
      summarize('Repeated sync', timings, performance.now() - start)

      expect(timings.filter((timing) => timing.status >= 300)).toEqual([])
      expect(await db.$count(auditEvent)).toBe(eventsBefore)
    },
    60 * 60_000,
  )
})
