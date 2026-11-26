/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createAuth } from '@/auth/auth'
import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { challengeTokenHeader, testSignInOtp } from '@/auth/otp-constants'
import * as settingsModule from '@/config/settings'
import type { db as DbType } from '@/db/client'
import {
  account,
  auditEvent,
  devicesTable,
  linkReview,
  membershipSource,
  orgMembership,
  scimGroup,
  scimGroupMember,
  scimUser,
  user,
} from '@/db/schema'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import { createPostgresTestDb, postgresTestUrl, waitForLockWaiters } from '@/test-utils/postgres'
import { createFakeOidcIdps, type FakeOidcIdps, fakeOidcClientId } from '@/test-utils/fake-oidc'
import { insertTestUsers } from '@/test-utils/identity'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { createScimClient, keycloakUser, type ScimClient, scimGroupSchema, uniqueSuffix } from '@/test-utils/scim'
import { createTestSettings } from '@/test-utils/settings'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { getAccess } from './access'
import { detachMemberLink } from './admin/members'
import { getCurrentOrganizationId } from './current-organization'
import { approveLinkReview } from './link-reviews'
import { getMemberAuthorization } from './roles'
import { createScimConnection, revokeScimCredential } from './scim/connections'
import { createScimGroupRoleMapping } from './scim/role-mappings'
import { createSsoConnection, updateSsoConnection } from './sso-connections'

/*
 * Several IdPs provisioning into one org, as several Keycloak realms or an Entra tenant beside a
 * Keycloak realm would: each connection has an SSO side and a SCIM side, and none may collide with
 * or write to another's identities.
 */
const databases = [
  {
    name: 'PGlite',
    skip: false,
    open: async () => ({ db: (await getSharedIsolatedTestDb()).db, close: async () => {} }),
  },
  // Postgres shows what concurrent transactions do, which PGlite, one query at a time, never does.
  { name: 'Postgres', skip: !postgresTestUrl, open: createPostgresTestDb },
]

describe.each(databases)('several connections in one org on $name', ({ name, skip, open }) => {
  if (skip) {
    it.skip('needs TEST_POSTGRES_URL', () => {})
    return
  }
  let db: typeof DbType
  let close: () => Promise<void>
  let auth: Auth
  let app: { handle: (request: Request) => Promise<Response> }
  let idps: FakeOidcIdps
  let actorId: string
  let settingsSpy: ReturnType<typeof spyOn>

  type Connection = {
    id: string
    providerId: string
    issuer: string
    credentialId: string
    scim: ScimClient
  }
  let acme: Connection
  let globex: Connection
  let initech: Connection

  const runSuffix = uniqueSuffix()
  const realms = ['acme', 'globex', 'initech', 'revoked', 'rotating']
  const issuerOf = (realm: string) => `https://${realm}-${runSuffix}.idp.test`

  const newConnection = async (realm: string): Promise<Connection> => {
    const providerId = `${realm}-${runSuffix}`
    const issuer = issuerOf(realm)
    const id = await createSsoConnection(db, {
      name: `${realm} ${runSuffix}`,
      providerId,
      protocol: { oidc: { issuer, clientId: fakeOidcClientId, clientSecret: `${realm}-secret` } },
      matchClaim: 'sub',
    })
    const { token, credential } = await createScimConnection(auth, { actorId, identityConnectionId: id })
    return { id, providerId, issuer, credentialId: credential.credentialId, scim: createScimClient(app.handle, token) }
  }

  beforeAll(async () => {
    ;({ db, close } = await open())
    settingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(
      createTestSettings({
        logLevel: 'ERROR',
        posthogHost: '',
        authMode: 'oidc',
        oidcIssuer: 'https://env.idp.test',
        oidcClientId: fakeOidcClientId,
        oidcClientSecret: 'env-secret',
      }),
    )
    idps = await createFakeOidcIdps(realms.map(issuerOf))
    // Better Auth reads its trusted origins, which must hold every issuer, when it is created.
    await idps.withIdps(async () => {
      auth = createAuth(db)
      const elysia = new Elysia({ prefix: '/v1' }).use(createBetterAuthPlugin(db).plugin)
      app = { handle: (request) => elysia.handle(request) }
    })
    actorId = `multi-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
    acme = await newConnection('acme')
    globex = await newConnection('globex')
    initech = await newConnection('initech')
  })

  afterAll(async () => {
    settingsSpy.mockRestore()
    await close()
  })

  const provision = async (
    connection: Connection,
    {
      email,
      externalId = crypto.randomUUID(),
      userName = email,
    }: {
      email: string
      externalId?: string
      userName?: string
    },
  ) => connection.scim.call('POST', '/Users', { body: keycloakUser(userName, email, externalId) })

  const userIdOf = async (email: string) =>
    (await db.select({ id: user.id }).from(user).where(eq(user.email, email)))[0]?.id

  const sourcesOf = (userId: string) =>
    db
      .select({ connectionId: membershipSource.identityConnectionId, status: membershipSource.status })
      .from(membershipSource)
      .innerJoin(orgMembership, eq(orgMembership.id, membershipSource.membershipId))
      .where(and(eq(orgMembership.userId, userId), eq(membershipSource.kind, 'scim')))

  const access = async (userId: string) => getAccess((await auth.$context).adapter, userId)

  const sessionUserOf = async (cookie: string) =>
    cookie ? (await auth.api.getSession({ headers: new Headers({ Cookie: cookie }) }))?.user.id : undefined

  const signIn = (connection: Connection, subject: string, email: string) =>
    idps.signIn(app, { providerId: connection.providerId, issuer: connection.issuer, subject, email })

  it('keeps one externalId from two connections as two people, each signing in to their own user', async () => {
    const externalId = crypto.randomUUID()
    const acmeEmail = `twin-${uniqueSuffix()}@acme.test`
    const globexEmail = `twin-${uniqueSuffix()}@globex.test`

    expect((await provision(acme, { email: acmeEmail, externalId })).status).toBe(201)
    expect((await provision(globex, { email: globexEmail, externalId })).status).toBe(201)

    const acmeUser = await userIdOf(acmeEmail)
    const globexUser = await userIdOf(globexEmail)
    expect(acmeUser).not.toBe(globexUser)
    expect(await sourcesOf(acmeUser)).toEqual([{ connectionId: acme.id, status: 'active' }])
    expect(await sourcesOf(globexUser)).toEqual([{ connectionId: globex.id, status: 'active' }])

    expect(await sessionUserOf((await signIn(acme, externalId, acmeEmail)).cookie)).toBe(acmeUser)
    expect(await sessionUserOf((await signIn(globex, externalId, globexEmail)).cookie)).toBe(globexUser)
    const accounts = await db
      .select({ providerId: account.providerId, userId: account.userId })
      .from(account)
      .where(eq(account.accountId, externalId))
    expect(accounts).toHaveLength(2)
    expect(accounts).toEqual(
      expect.arrayContaining([
        { providerId: acme.providerId, userId: acmeUser },
        { providerId: globex.providerId, userId: globexUser },
      ]),
    )
  })

  it('keeps one userName from two connections as two people, with no conflict and no re-bind', async () => {
    const userName = `alice-${uniqueSuffix()}`
    const acmeEmail = `${userName}@acme.test`
    const globexEmail = `${userName}@globex.test`

    const first = await provision(acme, { email: acmeEmail, userName })
    const second = await provision(globex, { email: globexEmail, userName })

    expect([first.status, second.status]).toEqual([201, 201])
    expect(await userIdOf(acmeEmail)).not.toBe(await userIdOf(globexEmail))
    const filter = `/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}`
    const acmeList = await acme.scim.call('GET', filter)
    expect(acmeList.body.Resources).toEqual([expect.objectContaining({ id: first.body.id })])
  })

  it('holds a same-email arrival on a second connection for review, then links it without taking the profile', async () => {
    const email = `pat-${uniqueSuffix()}@contractor.test`
    const created = await provision(acme, { email })
    expect(created.status).toBe(201)
    const patScimId = created.body.id!
    const patId = await userIdOf(email)
    const initechExternalId = crypto.randomUUID()

    const held = await provision(initech, { email, externalId: initechExternalId })

    expect(held.status).toBe(409)
    expect(await sourcesOf(patId)).toEqual([{ connectionId: acme.id, status: 'active' }])
    const [review] = await db
      .select()
      .from(linkReview)
      .where(and(eq(linkReview.identityConnectionId, initech.id), eq(linkReview.externalId, initechExternalId)))
    expect(review).toMatchObject({ candidateUserId: patId, status: 'pending' })

    await approveLinkReview(db, { reviewId: review.id, actorId })
    const linked = await provision(initech, { email, externalId: initechExternalId })

    expect(linked.status).toBe(201)
    expect(await userIdOf(email)).toBe(patId)
    expect((await sourcesOf(patId)).map((source) => source.connectionId).sort()).toEqual([acme.id, initech.id].sort())
    // The first connection keeps managing the profile: the second links with `preserve`.
    const emailOf = async () => (await db.select({ email: user.email }).from(user).where(eq(user.id, patId)))[0].email
    const moveTo = (connection: Connection, address: string) =>
      connection.scim.patch(`/Users/${connection === acme ? patScimId : linked.body.id}`, [
        { op: 'replace', path: 'emails', value: [{ value: address, type: 'work', primary: true }] },
      ])
    expect((await moveTo(initech, `moved-${email}`)).status).toBe(200)
    expect(await emailOf()).toBe(email)
    expect((await moveTo(acme, `moved-${email}`)).status).toBe(200)
    expect(await emailOf()).toBe(`moved-${email}`)
  })

  describe("a connection's token reaches only its own resources", () => {
    /** Every row a SCIM write could touch for these users and groups. */
    const snapshot = async (userIds: string[], groupIds: string[]) => ({
      users: await db.select().from(scimUser).where(inArray(scimUser.userId, userIds)),
      groups: await db.select().from(scimGroup).where(inArray(scimGroup.id, groupIds)),
      members: await db.select().from(scimGroupMember).where(inArray(scimGroupMember.groupId, groupIds)),
      people: await db.select().from(user).where(inArray(user.id, userIds)),
      sources: await db
        .select()
        .from(membershipSource)
        .innerJoin(orgMembership, eq(orgMembership.id, membershipSource.membershipId))
        .where(inArray(orgMembership.userId, userIds)),
    })

    it("can't read, change or delete another connection's users and groups", async () => {
      const acmeEmail = `own-${uniqueSuffix()}@acme.test`
      const globexEmail = `other-${uniqueSuffix()}@globex.test`
      const ownUser = (await provision(acme, { email: acmeEmail })).body.id!
      const otherUser = (await provision(globex, { email: globexEmail })).body.id!
      const ownGroup = (
        await acme.scim.call('POST', '/Groups', {
          body: { schemas: [scimGroupSchema], displayName: `A ${uniqueSuffix()}`, members: [{ value: ownUser }] },
        })
      ).body.id!
      const otherGroup = (
        await globex.scim.call('POST', '/Groups', {
          body: { schemas: [scimGroupSchema], displayName: `B ${uniqueSuffix()}`, members: [{ value: otherUser }] },
        })
      ).body.id!
      const userIds = [await userIdOf(acmeEmail), await userIdOf(globexEmail)]
      const before = await snapshot(userIds, [ownGroup, otherGroup])

      const attempts = [
        await acme.scim.call('GET', `/Users/${otherUser}`),
        await acme.scim.patch(`/Users/${otherUser}`, [{ op: 'replace', path: 'active', value: false }]),
        await acme.scim.call('PUT', `/Users/${otherUser}`, {
          body: keycloakUser(globexEmail, globexEmail, crypto.randomUUID()),
        }),
        await acme.scim.call('DELETE', `/Users/${otherUser}`),
        await acme.scim.call('GET', `/Groups/${otherGroup}`),
        await acme.scim.patch(`/Groups/${otherGroup}`, [{ op: 'replace', path: 'displayName', value: 'Admins' }]),
        await acme.scim.call('DELETE', `/Groups/${otherGroup}`),
      ]
      const addForeignMember = await acme.scim.patch(`/Groups/${ownGroup}`, [
        { op: 'add', path: 'members', value: [{ value: otherUser }] },
      ])

      expect(attempts.map((attempt) => attempt.status)).toEqual([404, 404, 404, 404, 404, 404, 404])

      expect(addForeignMember.body).toMatchObject({ status: '400', scimType: 'invalidValue' })
      expect(await snapshot(userIds, [ownGroup, otherGroup])).toEqual(before)
      const listed = await acme.scim.call('GET', '/Users?count=1000')
      expect((listed.body.Resources ?? []).map((resource) => resource.id)).not.toContain(otherUser)
    })

    it("attributes every event to the request's own connection", async () => {
      const email = `audited-${uniqueSuffix()}@globex.test`
      const created = await provision(globex, { email })
      await globex.scim.patch(`/Users/${created.body.id}`, [{ op: 'replace', path: 'active', value: false }])

      const events = await db
        .select({ action: auditEvent.action, connectionId: auditEvent.connectionId, actorType: auditEvent.actorType })
        .from(auditEvent)
        .where(eq(auditEvent.targetId, await userIdOf(email)))

      const scimEvents = events.filter((event) => event.action.startsWith('scim.'))
      expect(scimEvents.map((event) => event.action).sort()).toEqual(['scim.user_created', 'scim.user_deactivated'])
      for (const event of scimEvents) {
        expect(event).toMatchObject({ connectionId: globex.id, actorType: 'scim_connection' })
      }
    })
  })

  it('keeps a person one connection deletes while another still vouches for them, devices included', async () => {
    const email = `both-${uniqueSuffix()}@contractor.test`
    const acmeUser = (await provision(acme, { email })).body.id!
    const userId = await userIdOf(email)
    const externalId = crypto.randomUUID()
    expect((await provision(initech, { email, externalId })).status).toBe(409)
    const [review] = await db
      .select()
      .from(linkReview)
      .where(and(eq(linkReview.identityConnectionId, initech.id), eq(linkReview.externalId, externalId)))
    await approveLinkReview(db, { reviewId: review.id, actorId })
    const initechUser = (await provision(initech, { email, externalId })).body.id!
    const deviceId = crypto.randomUUID()
    await db.insert(devicesTable).values({ id: deviceId, userId, trusted: true, nodeId: `node-${deviceId}` })
    const revokedAt = async () =>
      (await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId)))[0].revokedAt

    expect((await acme.scim.call('DELETE', `/Users/${acmeUser}`)).status).toBe(204)

    expect(await access(userId)).toEqual({ allowed: true })
    expect(await revokedAt()).toBeNull()

    expect((await initech.scim.call('DELETE', `/Users/${initechUser}`)).status).toBe(204)

    expect(await access(userId)).toEqual({ allowed: false, reason: 'deprovisioned' })
    expect(await revokedAt()).not.toBeNull()
  })

  it("maps a role from one connection's group without reaching another connection's members", async () => {
    const acmeEmail = `mapped-${uniqueSuffix()}@acme.test`
    const globexEmail = `unmapped-${uniqueSuffix()}@globex.test`
    const acmeMember = (await provision(acme, { email: acmeEmail })).body.id!
    const globexMember = (await provision(globex, { email: globexEmail })).body.id!
    const displayName = `admins-${uniqueSuffix()}`
    const groupOf = async (connection: Connection, member: string) =>
      (
        await connection.scim.call('POST', '/Groups', {
          body: { schemas: [scimGroupSchema], displayName, members: [{ value: member }] },
        })
      ).body.id!
    const acmeGroup = await groupOf(acme, acmeMember)
    await groupOf(globex, globexMember)

    await createScimGroupRoleMapping(auth, db, {
      identityConnectionId: acme.id,
      scimGroupId: acmeGroup,
      role: 'admin',
      actorId,
    })

    const rolesOf = async (email: string) =>
      [
        ...(
          await getMemberAuthorization(
            { adapter: (await auth.$context).adapter, database: db },
            (await userIdOf(email))!,
          )
        ).roles,
      ].sort()
    expect(await rolesOf(acmeEmail)).toEqual(['admin', 'member'])
    expect(await rolesOf(globexEmail)).toEqual(['member'])
  })

  describe('detaching a link the IdP deleted', () => {
    const signInByCode = async (email: string) => {
      await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
      return (await auth.api.signInEmailOTP({
        body: { email, otp: testSignInOtp },
        headers: new Headers({ [challengeTokenHeader]: await createTestChallenge(db, email) }),
        asResponse: true,
      })) as Response
    }

    /** A member acme provisioned, signed in through acme once, invited locally, then deleted by acme. */
    const deletedMember = async () => {
      const email = `detached-${uniqueSuffix()}@contractor.test`
      const externalId = crypto.randomUUID()
      const scimId = (await provision(acme, { email, externalId })).body.id!
      const userId = await userIdOf(email)
      expect(await sessionUserOf((await signIn(acme, externalId, email)).cookie)).toBe(userId)
      const [membership] = await db.select().from(orgMembership).where(eq(orgMembership.userId, userId))
      await db.insert(membershipSource).values({
        id: crypto.randomUUID(),
        orgId: getCurrentOrganizationId(),
        membershipId: membership.id,
        kind: 'invitation',
        ref: 'local-invitation',
      })
      expect((await acme.scim.call('DELETE', `/Users/${scimId}`)).status).toBe(204)
      return { email, externalId, userId }
    }

    it('lets the local grant sign them in again, and keeps the IdP from relinking them silently', async () => {
      const { email, externalId, userId } = await deletedMember()
      expect(await access(userId)).toEqual({ allowed: false, reason: 'deprovisioned' })
      expect((await signInByCode(email)).status).toBe(403)

      await detachMemberLink(db, { userId, identityConnectionId: acme.id, actorId })

      expect(await access(userId)).toEqual({ allowed: true })
      expect((await signInByCode(email)).status).toBe(200)
      expect(
        await db.$count(auditEvent, and(eq(auditEvent.action, 'link.detached'), eq(auditEvent.targetId, userId))),
      ).toBe(1)

      // The deleted subject no longer signs in to the user, through SSO or a SCIM create.
      const viaSso = await signIn(acme, externalId, email)
      expect(await sessionUserOf(viaSso.cookie)).toBeUndefined()
      expect(await db.$count(account, and(eq(account.userId, userId), eq(account.providerId, acme.providerId)))).toBe(0)
      expect((await provision(acme, { email, externalId })).status).toBe(409)
      const [review] = await db
        .select()
        .from(linkReview)
        .where(and(eq(linkReview.identityConnectionId, acme.id), eq(linkReview.externalId, externalId)))
      expect(review).toMatchObject({ candidateUserId: userId, status: 'pending' })
      expect(await sourcesOf(userId)).toEqual([])

      // Once an admin approves the review, the IdP's retry links them again and SSO signs them in.
      await approveLinkReview(db, { reviewId: review.id, actorId })
      expect((await provision(acme, { email, externalId })).status).toBe(201)
      expect(await sourcesOf(userId)).toEqual([{ connectionId: acme.id, status: 'active' }])
      expect(await sessionUserOf((await signIn(acme, externalId, email)).cookie)).toBe(userId)
    })

    const lockWaiters = (count: number) => waitForLockWaiters(db, count)

    it.if(name === 'Postgres')(
      'refuses when a SCIM write reactivates the source while the detach waits for it',
      async () => {
        const { userId } = await deletedMember()
        const [membership] = await db.select().from(orgMembership).where(eq(orgMembership.userId, userId))
        const onAcme = and(
          eq(membershipSource.membershipId, membership.id),
          eq(membershipSource.identityConnectionId, acme.id),
        )
        const held = Promise.withResolvers<void>()
        const sourceLocked = Promise.withResolvers<void>()
        // A SCIM re-POST's reconcile, holding the row it reactivated until it commits.
        const reprovision = db.transaction(async (tx) => {
          await tx.update(membershipSource).set({ status: 'active' }).where(onAcme)
          sourceLocked.resolve()
          await held.promise
        })
        await sourceLocked.promise

        const detaching = detachMemberLink(db, { userId, identityConnectionId: acme.id, actorId }).catch(
          (error: unknown) => error,
        )
        await lockWaiters(1)
        held.resolve()
        await reprovision

        expect(await detaching).toMatchObject({ body: { code: 'LINK_SOURCE_ACTIVE' } })
        expect(await sourcesOf(userId)).toEqual([{ connectionId: acme.id, status: 'active' }])
      },
    )

    it.if(name === 'Postgres')(
      'makes a SCIM write that would reactivate the source wait until the detach commits',
      async () => {
        const { userId } = await deletedMember()
        const [membership] = await db.select().from(orgMembership).where(eq(orgMembership.userId, userId))
        const held = Promise.withResolvers<void>()
        const accountLocked = Promise.withResolvers<void>()
        // Holds the account the detach deletes last, so the detach waits holding the sources' locks.
        const blocker = db.transaction(async (tx) => {
          await tx
            .select()
            .from(account)
            .where(and(eq(account.userId, userId), eq(account.providerId, acme.providerId)))
            .for('update')
          accountLocked.resolve()
          await held.promise
        })
        await accountLocked.promise
        const detaching = detachMemberLink(db, { userId, identityConnectionId: acme.id, actorId })
        await lockWaiters(1)

        let flipped = false
        const flip = db
          .update(membershipSource)
          .set({ status: 'active' })
          .where(
            and(eq(membershipSource.membershipId, membership.id), eq(membershipSource.identityConnectionId, acme.id)),
          )
          .returning()
          .then((rows) => {
            flipped = true
            return rows
          })
        await lockWaiters(2)
        expect(flipped).toBe(false)

        held.resolve()
        await blocker
        await detaching
        expect(await flip).toEqual([])
        expect(await sourcesOf(userId)).toEqual([])
      },
    )
  })

  it('keeps signing a member in through a connection whose client secret an admin replaced, with no relinking', async () => {
    // Its own connection: the rotation must not leak into the other tests' sign-ins.
    const rotating = await newConnection('rotating')
    const email = `rotated-${uniqueSuffix()}@acme.test`
    const externalId = crypto.randomUUID()
    expect((await provision(rotating, { email, externalId })).status).toBe(201)
    const userId = await userIdOf(email)
    idps.setClientSecret(rotating.issuer, 'rotating-secret')
    expect(await sessionUserOf((await signIn(rotating, externalId, email)).cookie)).toBe(userId)
    const links = () =>
      db.$count(auditEvent, and(eq(auditEvent.action, 'link.created'), eq(auditEvent.targetId, userId)))
    const linksBefore = await links()

    idps.setClientSecret(rotating.issuer, 'rotated-secret')
    expect(await sessionUserOf((await signIn(rotating, externalId, email)).cookie)).toBeUndefined()
    const context = await auth.$context
    await updateSsoConnection(db, {
      identityConnectionId: rotating.id,
      oidc: { clientSecret: 'rotated-secret' },
      actorId,
      isTrustedOrigin: (url) => context.isTrustedOrigin(url),
    })

    expect(await sessionUserOf((await signIn(rotating, externalId, email)).cookie)).toBe(userId)
    expect(await db.$count(account, and(eq(account.userId, userId), eq(account.providerId, rotating.providerId)))).toBe(
      1,
    )
    expect(await links()).toBe(linksBefore)
  })

  it("keeps the other connections syncing when one connection's credential is revoked", async () => {
    const victim = await newConnection('revoked')

    await revokeScimCredential(auth, { identityConnectionId: victim.id, credentialId: victim.credentialId, actorId })

    expect((await provision(victim, { email: `gone-${uniqueSuffix()}@acme.test` })).status).toBe(401)
    expect((await provision(globex, { email: `kept-${uniqueSuffix()}@globex.test` })).status).toBe(201)
  })
})
