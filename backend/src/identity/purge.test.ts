/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createAuth } from '@/auth/auth'
import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import {
  auditEvent,
  membershipSource,
  orgEnvelopesTable,
  orgMembership,
  scimIdentityTombstone,
  user,
} from '@/db/schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { createPostgresTestDb, postgresTestUrl } from '@/test-utils/postgres'
import { addTestMembership, insertTestUsers } from '@/test-utils/identity'
import { createScimClient, keycloakUser, type ScimClient, uniqueSuffix } from '@/test-utils/scim'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { purgeMember } from './purge'
import { createScimConnection } from './scim/connections'

describe('purgeMember', () => {
  let db: IsolatedTestDb['db']
  let auth: Auth
  let scim: ScimClient
  let actorId: string

  beforeAll(async () => {
    ;({ db } = await getSharedIsolatedTestDb())
    auth = createAuth(db)
    const app = new Elysia({ prefix: '/v1' }).use(createBetterAuthPlugin(db).plugin)
    actorId = `purge-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
    const { token } = await createScimConnection(auth, { actorId, name: `IdP ${uniqueSuffix()}` })
    scim = createScimClient((request) => app.handle(request), token)
  })

  const provision = async () => {
    const email = `purge-${uniqueSuffix()}@example.com`
    const created = await scim.call('POST', '/Users', { body: keycloakUser(email, email, crypto.randomUUID()) })
    expect(created.status).toBe(201)
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
    return { userId: row.id, scimId: created.body.id! }
  }

  const localMember = async () => {
    const userId = crypto.randomUUID()
    await db.insert(user).values({ id: userId, name: 'Local', email: `${userId}@example.com`, emailVerified: true })
    const membership = await addTestMembership(db, userId)
    return { userId, membership }
  }

  const exists = async (userId: string) => (await db.$count(user, eq(user.id, userId))) === 1

  it('purges a member an IdP deleted, with their tombstone and escrow envelope', async () => {
    const { userId, scimId } = await provision()
    await db.insert(orgEnvelopesTable).values({ userId, wrappedAk: 'wrapped' })
    expect((await scim.call('DELETE', `/Users/${scimId}`)).status).toBe(204)
    expect(await db.$count(scimIdentityTombstone, eq(scimIdentityTombstone.userId, userId))).toBe(1)

    await purgeMember(db, { userId, actorId })

    expect(await exists(userId)).toBe(false)
    expect(await db.$count(scimIdentityTombstone, eq(scimIdentityTombstone.userId, userId))).toBe(0)
    expect(await db.$count(orgEnvelopesTable, eq(orgEnvelopesTable.userId, userId))).toBe(0)
    const [purged] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'member.purged'), eq(auditEvent.targetId, userId)))
    expect(purged).toMatchObject({ actorId, outcome: 'success', metadata: { reason: 'deprovisioned' } })
  })

  it('purges a blocked member and a local member with no live source', async () => {
    const blocked = await localMember()
    await db.update(orgMembership).set({ blockedAt: new Date() }).where(eq(orgMembership.id, blocked.membership.id))
    const lapsed = await localMember()
    await db
      .update(membershipSource)
      .set({ status: 'removed' })
      .where(eq(membershipSource.membershipId, lapsed.membership.id))

    await purgeMember(db, { userId: blocked.userId, actorId })
    await purgeMember(db, { userId: lapsed.userId, actorId })

    expect(await exists(blocked.userId)).toBe(false)
    expect(await exists(lapsed.userId)).toBe(false)
  })

  it('refuses a member with access, one an IdP only suspended, and the admin themselves', async () => {
    const withAccess = await provision()
    const suspended = await provision()
    await scim.patch(`/Users/${suspended.scimId}`, [{ op: 'replace', path: 'active', value: false }])

    await expect(purgeMember(db, { userId: withAccess.userId, actorId })).rejects.toMatchObject({
      body: { code: 'MEMBER_HAS_ACCESS' },
    })
    await expect(purgeMember(db, { userId: suspended.userId, actorId })).rejects.toMatchObject({
      body: { code: 'MEMBER_SUSPENDED_BY_IDP' },
    })
    await expect(purgeMember(db, { userId: actorId, actorId })).rejects.toMatchObject({
      body: { code: 'PURGE_SELF' },
    })
    expect(await exists(withAccess.userId)).toBe(true)
    expect(await exists(suspended.userId)).toBe(true)
  })
})

// PGlite runs one query at a time, so only a real Postgres shows two transactions interleaving.
describe.skipIf(!postgresTestUrl)('purgeMember on Postgres', () => {
  let postgresDb: Awaited<ReturnType<typeof createPostgresTestDb>>

  beforeAll(async () => {
    postgresDb = await createPostgresTestDb()
  })
  afterAll(() => postgresDb.close())

  it('refuses a member whose access comes back while the purge waits for their rows', async () => {
    const { db } = postgresDb
    const actorId = crypto.randomUUID()
    const userId = crypto.randomUUID()
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
    await db.insert(user).values({ id: userId, name: 'Lapsed', email: `${userId}@example.com`, emailVerified: true })
    const membership = await addTestMembership(db, userId)
    const ofMember = eq(membershipSource.membershipId, membership.id)
    await db.update(membershipSource).set({ status: 'removed' }).where(ofMember)

    const { promise: locked, resolve: lock } = Promise.withResolvers<void>()
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    const restore = db.transaction(async (tx) => {
      await tx.update(membershipSource).set({ status: 'active' }).where(ofMember)
      lock()
      await held
    })
    await locked
    const purge = purgeMember(db, { userId, actorId }).catch((error: unknown) => error)
    // Long enough for the purge to reach the rows the restore holds.
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    await restore

    expect(await purge).toMatchObject({ body: { code: 'MEMBER_HAS_ACCESS' } })
    expect(await db.$count(user, eq(user.id, userId))).toBe(1)
  })
})
