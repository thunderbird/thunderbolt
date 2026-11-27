/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { insertTestUsers } from '@/test-utils/identity'
import { createPostgresTestDb, postgresTestUrl } from '@/test-utils/postgres'
import { createScimClient, entraUser, type ScimClient, scimGroupSchema, uniqueSuffix } from '@/test-utils/scim'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createSharedLock, isPostgres } from './concurrency'
import { createScimConnection } from './connections'

/*
 * Postgres only: PGlite runs one query at a time, so the plugin's optimistic-lock conflicts never
 * happen there. Each test sends an IdP's parallel writes to one user or one group.
 */
describe.skipIf(!postgresTestUrl)('concurrent SCIM writes on Postgres', () => {
  let close: () => Promise<void>
  let database: Awaited<ReturnType<typeof createPostgresTestDb>>['db']
  let token: string
  /** One app, like a single worker. */
  let scim: ScimClient
  /** One app per request in flight, each with its own in-process lock: as if on separate workers. */
  let workers: ScimClient

  beforeAll(async () => {
    const testDb = await createPostgresTestDb()
    close = testDb.close
    database = testDb.db
    const app = () => new Elysia({ prefix: '/v1' }).use(createBetterAuthPlugin(testDb.db).plugin)
    const [first, ...others] = Array.from({ length: 8 }, app)
    const actorId = `scim-admin-${uniqueSuffix()}`
    await insertTestUsers(testDb.db, {
      id: actorId,
      name: 'Admin',
      email: `${actorId}@example.com`,
      emailVerified: true,
    })
    ;({ token } = await createScimConnection(createBetterAuthPlugin(testDb.db).auth, {
      actorId,
      name: `Entra ${uniqueSuffix()}`,
    }))
    scim = createScimClient((request) => first.handle(request), token)
    let turn = 0
    workers = createScimClient((request) => others[turn++ % others.length].handle(request), token)
  }, 60_000)

  afterAll(async () => {
    await close?.()
  })

  const createUser = async () => {
    const response = await scim.call('POST', '/Users', {
      body: entraUser(`race-${uniqueSuffix()}@contoso.test`, `oid-${uniqueSuffix()}`),
    })
    expect(response.status).toBe(201)
    return response.body
  }

  const parallelPatches = async (client: ScimClient) => {
    const created = await createUser()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        client.patch(`/Users/${created.id}`, [{ op: 'Replace', path: 'displayName', value: `Name ${index}` }]),
      ),
    )
    expect(results.map((result) => result.status)).toEqual(Array(8).fill(200))
  }

  const parallelMemberAdds = async (client: ScimClient) => {
    const group = await scim.call('POST', '/Groups', {
      body: { schemas: [scimGroupSchema], displayName: `Race ${uniqueSuffix()}` },
    })
    const members = await Promise.all(Array.from({ length: 6 }, createUser))
    const results = await Promise.all(
      members.map((member) =>
        client.patch(`/Groups/${group.body.id}`, [{ op: 'Add', path: 'members', value: [{ value: member.id }] }]),
      ),
    )
    expect(results.map((result) => result.status)).toEqual(Array(6).fill(200))
    const final = await scim.call('GET', `/Groups/${group.body.id}`)
    expect(final.body.members?.map((member) => member.value).sort()).toEqual(members.map((member) => member.id!).sort())
  }

  it('8 parallel PATCHes on one user all succeed', () => parallelPatches(scim))

  it('6 parallel member adds on one group all succeed and all land', () => parallelMemberAdds(scim))

  it('across workers, the retry settles the conflicts the lock cannot see', async () => {
    await parallelPatches(workers)
    await parallelMemberAdds(workers)
  })

  it('a shared lock holds one key across instances and lets other keys run', async () => {
    expect(isPostgres(database)).toBe(true)
    const [first, second] = [createSharedLock(database), createSharedLock(database)]
    const order: string[] = []
    const { promise: released, resolve: release } = Promise.withResolvers<void>()
    const holding = first('scim:Users:shared', async () => {
      order.push('first in')
      await released
      order.push('first out')
    })
    await Bun.sleep(50)
    const waiting = second('scim:Users:shared', async () => {
      order.push('second in')
    })
    await second('scim:Users:other', async () => {
      order.push('other key')
    })
    await Bun.sleep(50)
    release()
    await Promise.all([holding, waiting])
    expect(order).toEqual(['first in', 'other key', 'first out', 'second in'])
  })

  it('opens at most three lock transactions at once per instance', async () => {
    const lock = createSharedLock(database)
    let open = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        lock(`scim:Users:peak-${index}`, async () => {
          open++
          peak = Math.max(peak, open)
          await Bun.sleep(20)
          open--
        }),
      ),
    )
    expect(peak).toBe(3)
  })

  it('across workers, a value-filtered email change keeps an email another worker adds', async () => {
    for (let round = 0; round < 5; round++) {
      const created = await createUser()
      const address = created.userName!
      const added = `added-${uniqueSuffix()}@contoso.test`
      const renamed = `renamed-${uniqueSuffix()}@contoso.test`
      const results = await Promise.all([
        workers.patch(`/Users/${created.id}`, [{ op: 'add', path: 'emails', value: [{ value: added, type: 'home' }] }]),
        workers.patch(`/Users/${created.id}`, [
          { op: 'replace', path: `emails[value eq "${address}"].value`, value: renamed },
        ]),
      ])
      expect(results.map((result) => result.status)).toEqual([200, 200])
      const final = await scim.call('GET', `/Users/${created.id}`)
      expect(final.body.emails?.map((email) => email.value).sort()).toEqual([added, renamed].sort())
    }
  })

  it('parallel identical creates still answer one 201 and the rest 409 uniqueness', async () => {
    const body = entraUser(`dup-${uniqueSuffix()}@contoso.test`, `oid-${uniqueSuffix()}`)
    const results = await Promise.all(Array.from({ length: 5 }, () => workers.call('POST', '/Users', { body })))
    const statuses = results.map((result) => result.status).sort()
    expect(statuses).toEqual([201, 409, 409, 409, 409])
    expect(
      results.filter((result) => result.status === 409).every((result) => result.body.scimType === 'uniqueness'),
    ).toBe(true)
  })
})
