/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createAuth } from '@/auth/auth'
import {
  auditEvent,
  devicesTable,
  envelopesTable,
  linkReview,
  membershipSource,
  orgDomain,
  orgMembership,
  scimSubject,
  scimUser,
  session as sessionTable,
  user,
} from '@/db/schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { insertTestUsers } from '@/test-utils/identity'
import { createScimClient, keycloakUser, type ScimClient, uniqueSuffix } from '@/test-utils/scim'
import { beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { getCurrentOrganizationId } from '../current-organization'
import { approveLinkReview, rejectLinkReview } from '../link-reviews'
import { createScimConnection } from './connections'

describe('SCIM linking', () => {
  let db: IsolatedTestDb['db']
  let harness: TestAppHandle
  let auth: Auth
  let actorId: string

  beforeAll(async () => {
    ;({ db } = await getSharedIsolatedTestDb())
    harness = await createTestApp({ database: db })
    auth = createAuth(db)
    actorId = `scim-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
  })

  const newConnection = async () => {
    const { connection, token } = await createScimConnection(auth, { actorId, name: `IdP ${uniqueSuffix()}` })
    return { connection, scim: createScimClient((request) => harness.app.handle(request), token) }
  }

  /** A domain of its own for each test, since the suites share one database. */
  const newDomain = () => `corp-${uniqueSuffix()}.example`

  const addDomain = (domain: string, { verified, claimedBy }: { verified: boolean; claimedBy: string | null }) =>
    db.insert(orgDomain).values({
      id: crypto.randomUUID(),
      orgId: getCurrentOrganizationId(),
      domain,
      verificationToken: crypto.randomUUID(),
      verifiedAt: verified ? new Date() : null,
      // Claims are written by the admin API; these tests only need the row as it would be.
      claimedByConnectionId: claimedBy,
    })

  /** An existing user who signed up by email code, with a session, a trusted device and its envelope. */
  const existingUser = async (email: string) => {
    const id = crypto.randomUUID()
    await insertTestUsers(db, { id, name: 'Local Ada', email, emailVerified: true })
    const deviceId = crypto.randomUUID()
    await db.insert(devicesTable).values({ id: deviceId, userId: id, trusted: true, nodeId: `node-${deviceId}` })
    await db.insert(envelopesTable).values({ deviceId, userId: id, wrappedCk: 'wrapped' })
    await db.insert(sessionTable).values({
      id: crypto.randomUUID(),
      userId: id,
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    return { id, deviceId }
  }

  const create = (scim: ScimClient, email: string, externalId: string, userName = email) =>
    scim.call('POST', '/Users', { body: keycloakUser(userName, email, externalId) })

  const reviewsOf = (identityConnectionId: string) =>
    db.select().from(linkReview).where(eq(linkReview.identityConnectionId, identityConnectionId))

  const scimUsersOf = (userId: string) => db.select().from(scimUser).where(eq(scimUser.userId, userId))

  const sourcesOf = (userId: string) =>
    db
      .select({ kind: membershipSource.kind, connectionId: membershipSource.identityConnectionId })
      .from(membershipSource)
      .innerJoin(orgMembership, eq(orgMembership.id, membershipSource.membershipId))
      .where(eq(orgMembership.userId, userId))

  const linkEvents = (userId: string) =>
    db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'link.created'), eq(auditEvent.targetId, userId)))

  /** What a link must never touch: the user's devices, envelopes and sessions. */
  const keyMaterialOf = async (userId: string) => ({
    devices: await db.select().from(devicesTable).where(eq(devicesTable.userId, userId)),
    envelopes: await db.$count(envelopesTable, eq(envelopesTable.userId, userId)),
    sessions: await db.$count(sessionTable, eq(sessionTable.userId, userId)),
  })

  describe('on a domain that is not verified and claimed by the connection', () => {
    it('refuses the create with 409, opens one review and gives the existing user nothing', async () => {
      const { connection, scim } = await newConnection()
      const email = `ada@${newDomain()}`
      const existing = await existingUser(email)
      const before = await keyMaterialOf(existing.id)

      const first = await create(scim, email, 'oid-1')
      const retry = await create(scim, email, 'oid-1')

      expect(first.status).toBe(409)
      expect(first.body.scimType).toBe('uniqueness')
      expect(retry.status).toBe(409)
      expect(await reviewsOf(connection.id)).toEqual([
        expect.objectContaining({
          trigger: 'scim_create_conflict',
          externalId: 'oid-1',
          incomingEmail: email,
          candidateUserId: existing.id,
          status: 'pending',
          attempts: 2,
        }),
      ])
      expect(await scimUsersOf(existing.id)).toEqual([])
      expect(await sourcesOf(existing.id)).toEqual([{ kind: 'local', connectionId: null }])
      expect(await keyMaterialOf(existing.id)).toEqual(before)
      expect(await linkEvents(existing.id)).toEqual([])
    })

    it.each([
      { case: 'verified but claimed by another connection', verified: true, claimedByOther: true },
      { case: 'claimed but not verified', verified: false, claimedByOther: false },
    ])('does not link automatically when the domain is $case', async ({ verified, claimedByOther }) => {
      const { connection, scim } = await newConnection()
      const other = claimedByOther ? (await newConnection()).connection : connection
      const domain = newDomain()
      await addDomain(domain, { verified, claimedBy: other.id })
      const existing = await existingUser(`ada@${domain}`)

      expect((await create(scim, `ada@${domain}`, 'oid-1')).status).toBe(409)
      expect(await reviewsOf(connection.id)).toHaveLength(1)
      expect(await scimUsersOf(existing.id)).toEqual([])
    })

    it('does not trust a subdomain of a claimed domain', async () => {
      const { connection, scim } = await newConnection()
      const domain = newDomain()
      await addDomain(domain, { verified: true, claimedBy: connection.id })
      await existingUser(`ada@eu.${domain}`)

      expect((await create(scim, `ada@eu.${domain}`, 'oid-1')).status).toBe(409)
      expect(await reviewsOf(connection.id)).toHaveLength(1)
    })

    it("attaches the IdP's retry to the existing user once an admin approves", async () => {
      const { connection, scim } = await newConnection()
      const email = `ada@${newDomain()}`
      const existing = await existingUser(email)
      const before = await keyMaterialOf(existing.id)
      expect((await create(scim, email, 'oid-1')).status).toBe(409)
      const [review] = await reviewsOf(connection.id)

      await approveLinkReview(db, { reviewId: review.id, actorId })
      const retry = await create(scim, email, 'oid-1')

      expect(retry.status).toBe(201)
      expect((await scimUsersOf(existing.id)).map((row) => row.id)).toEqual([retry.body.id!])
      expect(await sourcesOf(existing.id)).toContainEqual({ kind: 'scim', connectionId: connection.id })
      expect((await reviewsOf(connection.id))[0].status).toBe('linked')
      expect(await linkEvents(existing.id)).toEqual([
        expect.objectContaining({
          actorType: 'scim_connection',
          connectionId: connection.id,
          metadata: { tier: 'review', reviewId: review.id },
        }),
      ])
      expect(await db.$count(user, eq(user.email, email))).toBe(1)
      // A link attaches an identity; it never merges keys, so devices and envelopes stay as they were.
      expect((await keyMaterialOf(existing.id)).devices).toEqual(before.devices)
      expect((await keyMaterialOf(existing.id)).envelopes).toBe(before.envelopes)
    })

    it('keeps refusing after a rejection, counting the retries on the rejected review', async () => {
      const { connection, scim } = await newConnection()
      const email = `ada@${newDomain()}`
      const existing = await existingUser(email)
      await create(scim, email, 'oid-1')
      const [review] = await reviewsOf(connection.id)
      await rejectLinkReview(db, { reviewId: review.id, actorId })

      expect((await create(scim, email, 'oid-1')).status).toBe(409)

      expect(await reviewsOf(connection.id)).toEqual([
        expect.objectContaining({ id: review.id, status: 'rejected', attempts: 2 }),
      ])
      expect(await scimUsersOf(existing.id)).toEqual([])
    })
  })

  describe('on a domain verified and claimed by the connection', () => {
    it('links the create to the existing user automatically, with an audit event', async () => {
      const { connection, scim } = await newConnection()
      const domain = newDomain()
      await addDomain(domain, { verified: true, claimedBy: connection.id })
      const existing = await existingUser(`ada@${domain}`)
      const before = await keyMaterialOf(existing.id)

      const created = await create(scim, `ada@${domain}`, 'oid-1')

      expect(created.status).toBe(201)
      expect((await scimUsersOf(existing.id)).map((row) => row.id)).toEqual([created.body.id!])
      expect(await sourcesOf(existing.id)).toContainEqual({ kind: 'scim', connectionId: connection.id })
      expect(await reviewsOf(connection.id)).toEqual([])
      expect(await linkEvents(existing.id)).toEqual([
        expect.objectContaining({ actorId: connection.id, metadata: { tier: 'domain' } }),
      ])
      // The first IdP to link a local user manages its profile from then on.
      const [subject] = await db.select().from(scimSubject).where(eq(scimSubject.userId, existing.id))
      expect(subject.profileSourceId).toBe(created.body.id!)
      expect((await keyMaterialOf(existing.id)).devices).toEqual(before.devices)
    })

    it('sends a recreated user (new externalId, same email) to review rather than linking', async () => {
      const { connection, scim } = await newConnection()
      const domain = newDomain()
      await addDomain(domain, { verified: true, claimedBy: connection.id })
      const email = `ada@${domain}`
      const original = await create(scim, email, 'keycloak-uuid-1')
      expect(original.status).toBe(201)
      const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
      expect((await scim.call('DELETE', `/Users/${original.body.id}`)).status).toBe(204)

      const recreated = await create(scim, email, 'keycloak-uuid-2')

      expect(recreated.status).toBe(409)
      const [review] = await reviewsOf(connection.id)
      expect(review).toMatchObject({ externalId: 'keycloak-uuid-2', candidateUserId: owner.id, status: 'pending' })

      await approveLinkReview(db, { reviewId: review.id, actorId })
      const retry = await create(scim, email, 'keycloak-uuid-2')

      expect(retry.status).toBe(201)
      expect((await scimUsersOf(owner.id)).map((row) => row.externalId)).toEqual(['keycloak-uuid-2'])
    })

    it('refuses to approve a recreated user while the old record still exists', async () => {
      const { connection, scim } = await newConnection()
      const domain = newDomain()
      await addDomain(domain, { verified: true, claimedBy: connection.id })
      const email = `ada@${domain}`
      const original = await create(scim, email, 'keycloak-uuid-1', 'ada')
      await scim.patch(`/Users/${original.body.id}`, [{ op: 'replace', path: 'active', value: false }])

      expect((await create(scim, email, 'keycloak-uuid-2', 'ada2')).status).toBe(409)
      const [review] = await reviewsOf(connection.id)

      const refused = await approveLinkReview(db, { reviewId: review.id, actorId }).catch((error: unknown) => error)
      expect(refused).toMatchObject({ code: 'LINK_REVIEW_RECORD_EXISTS' })
    })
  })

  describe('two IdPs, one person', () => {
    it('links the second IdP with the profile preserved, so the first keeps managing email and name', async () => {
      const entra = await newConnection()
      const keycloak = await newConnection()
      const email = `ada@${newDomain()}`
      const fromEntra = await create(entra.scim, email, 'entra-oid')
      expect(fromEntra.status).toBe(201)
      const [person] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))

      expect((await create(keycloak.scim, email, 'keycloak-uuid')).status).toBe(409)
      const [review] = await reviewsOf(keycloak.connection.id)
      await approveLinkReview(db, { reviewId: review.id, actorId })
      const fromKeycloak = await create(keycloak.scim, email, 'keycloak-uuid')

      expect(fromKeycloak.status).toBe(201)
      expect((await scimUsersOf(person.id)).map((row) => row.id).sort()).toEqual(
        [fromEntra.body.id!, fromKeycloak.body.id!].sort(),
      )
      const [subject] = await db.select().from(scimSubject).where(eq(scimSubject.userId, person.id))
      expect(subject.profileSourceId).toBe(fromEntra.body.id!)
      expect(await sourcesOf(person.id)).toEqual(
        expect.arrayContaining([
          { kind: 'scim', connectionId: entra.connection.id },
          { kind: 'scim', connectionId: keycloak.connection.id },
        ]),
      )

      const rename = (scim: ScimClient, scimId: string, displayName: string) =>
        scim.patch(`/Users/${scimId}`, [{ op: 'replace', path: 'displayName', value: displayName }])
      const nameOf = async () => (await db.select({ name: user.name }).from(user).where(eq(user.id, person.id)))[0].name

      expect((await rename(keycloak.scim, fromKeycloak.body.id!, 'From Keycloak')).status).toBe(200)
      expect(await nameOf()).not.toBe('From Keycloak')
      expect((await rename(entra.scim, fromEntra.body.id!, 'From Entra')).status).toBe(200)
      expect(await nameOf()).toBe('From Entra')
    })
  })
})
