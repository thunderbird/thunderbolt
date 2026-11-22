/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  account,
  auditEvent,
  groupRoleMapping,
  identityConnection,
  invitation,
  linkReview,
  localGroup,
  memberRoleGrant,
  membershipSource,
  orgDomain,
  orgMembership,
  scimIdentityTombstone,
  session,
  ssoProvider,
  user,
} from '@/db/schema'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { insertTestUsers } from '@/test-utils/identity'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, ne, sql } from 'drizzle-orm'
import { getCurrentOrganizationId } from '../current-organization'
import { envSsoConnectionId } from '../sso-connections'
import { getBreakGlassStatus } from './members'

const orgId = getCurrentOrganizationId()

const oidcBody = (providerId: string) => ({
  name: `IdP ${providerId}`,
  providerId,
  protocol: { oidc: { issuer: `https://${providerId}.test`, clientId: 'thunderbolt', clientSecret: 'top-secret' } },
})

/**
 * Every admin route, with a body that passes validation. A test below checks this list against the
 * routes the app registers, so a new admin route can't skip the 403 checks.
 */
const adminRoutes: { method: string; path: string; body?: unknown }[] = [
  { method: 'GET', path: '/v1/admin/audit-events' },
  { method: 'GET', path: '/v1/admin/members' },
  { method: 'GET', path: '/v1/admin/members/:userId' },
  { method: 'PATCH', path: '/v1/admin/members/:userId', body: { name: 'New name' } },
  { method: 'POST', path: '/v1/admin/members/:userId/block', body: {} },
  { method: 'POST', path: '/v1/admin/members/:userId/unblock' },
  { method: 'POST', path: '/v1/admin/members/:userId/roles', body: { role: 'admin' } },
  { method: 'DELETE', path: '/v1/admin/members/:userId/roles/:role' },
  { method: 'POST', path: '/v1/admin/members/:userId/connections/:connectionId/detach' },
  { method: 'DELETE', path: '/v1/admin/members/:userId' },
  { method: 'GET', path: '/v1/admin/break-glass' },
  { method: 'GET', path: '/v1/admin/groups' },
  { method: 'POST', path: '/v1/admin/groups', body: { name: 'Finance' } },
  { method: 'GET', path: '/v1/admin/groups/:groupId' },
  { method: 'PATCH', path: '/v1/admin/groups/:groupId', body: { name: 'Finance' } },
  { method: 'DELETE', path: '/v1/admin/groups/:groupId' },
  { method: 'GET', path: '/v1/admin/groups/:groupId/members' },
  { method: 'POST', path: '/v1/admin/groups/:groupId/members', body: { userId: 'someone' } },
  { method: 'DELETE', path: '/v1/admin/groups/:groupId/members/:userId' },
  { method: 'GET', path: '/v1/admin/role-mappings' },
  { method: 'POST', path: '/v1/admin/role-mappings', body: { localGroupId: 'group', role: 'admin' } },
  { method: 'DELETE', path: '/v1/admin/role-mappings/:mappingId' },
  { method: 'GET', path: '/v1/admin/connections' },
  { method: 'GET', path: '/v1/admin/connections/:connectionId' },
  { method: 'GET', path: '/v1/admin/connections/:connectionId/scim-groups' },
  { method: 'POST', path: '/v1/admin/connections/sso', body: oidcBody('okta') },
  { method: 'PATCH', path: '/v1/admin/connections/:connectionId', body: { name: 'Renamed' } },
  { method: 'POST', path: '/v1/admin/connections/:connectionId/retire' },
  { method: 'POST', path: '/v1/admin/connections/scim', body: { name: 'Entra' } },
  { method: 'POST', path: '/v1/admin/connections/:connectionId/scim/credentials', body: {} },
  { method: 'POST', path: '/v1/admin/connections/:connectionId/scim/credentials/:credentialId/revoke' },
  { method: 'POST', path: '/v1/admin/connections/:connectionId/scim/retire' },
  { method: 'GET', path: '/v1/admin/invitations' },
  { method: 'POST', path: '/v1/admin/invitations', body: { email: 'contractor@example.org' } },
  { method: 'POST', path: '/v1/admin/invitations/:invitationId/revoke' },
  { method: 'GET', path: '/v1/admin/domains' },
  { method: 'POST', path: '/v1/admin/domains', body: { domain: 'corp.test' } },
  { method: 'POST', path: '/v1/admin/domains/:domainId/verify' },
  { method: 'PUT', path: '/v1/admin/domains/:domainId/enrollment', body: { enabled: true } },
  { method: 'PUT', path: '/v1/admin/domains/:domainId/claim', body: { identityConnectionId: 'connection' } },
  { method: 'DELETE', path: '/v1/admin/domains/:domainId/claim' },
  { method: 'DELETE', path: '/v1/admin/domains/:domainId' },
  { method: 'GET', path: '/v1/admin/link-reviews' },
  { method: 'POST', path: '/v1/admin/link-reviews/:reviewId/approve' },
  { method: 'POST', path: '/v1/admin/link-reviews/:reviewId/reject' },
]

/** A route template with each `:param` filled; `:role` gets a role the schema accepts. */
const fillPath = (path: string) =>
  path.replace(/:(\w+)/g, (_, name: string) => (name === 'role' ? 'admin' : `${name}-1`))

describe('admin API', () => {
  let harness: TestAppHandle
  let adminId: string

  beforeEach(async () => {
    harness = await createTestApp()
    const [row] = await harness.db.select({ id: user.id }).from(user).where(eq(user.email, harness.email))
    adminId = row.id
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  const call = (method: string, path: string, body?: unknown, headers = authHeaders(harness.bearerToken)) =>
    harness.app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )

  const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T

  const membershipOf = async (userId: string) => {
    const [row] = await harness.db.select().from(orgMembership).where(eq(orgMembership.userId, userId))
    return row
  }

  const grantAdmin = async (userId: string) => {
    await harness.db.insert(memberRoleGrant).values({
      id: crypto.randomUUID(),
      orgId,
      membershipId: (await membershipOf(userId)).id,
      role: 'admin',
      source: 'local',
    })
  }

  const addMember = async (email = `member-${crypto.randomUUID()}@example.com`) => {
    const id = crypto.randomUUID()
    await insertTestUsers(harness.db, { id, name: 'Member', email, emailVerified: true })
    return id
  }

  const events = (action: string, outcome = 'success') =>
    harness.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action), eq(auditEvent.outcome, outcome as 'success')))

  /** A connection whose SCIM side is active, and a member it manages, written straight to the tables. */
  /** A member managed by SCIM; with `sso`, their connection has an SSO side too, so they need SSO. */
  const addIdpManagedMember = async ({ sso = false }: { sso?: boolean } = {}) => {
    const providerId = `idp-${crypto.randomUUID()}`
    const [provider] = sso
      ? await harness.db
          .insert(ssoProvider)
          .values({ id: crypto.randomUUID(), providerId, issuer: `https://${providerId}.test`, domain: '' })
          .returning()
      : [null]
    const [connection] = await harness.db
      .insert(identityConnection)
      .values({
        id: crypto.randomUUID(),
        orgId,
        name: `Entra ${crypto.randomUUID()}`,
        ssoProviderId: provider?.id ?? null,
        scimConnectionId: crypto.randomUUID(),
      })
      .returning()
    const userId = crypto.randomUUID()
    await harness.db
      .insert(user)
      .values({ id: userId, name: 'Employee', email: `${userId}@corp.test`, emailVerified: true })
    const [membership] = await harness.db
      .insert(orgMembership)
      .values({ id: crypto.randomUUID(), orgId, userId })
      .returning()
    await harness.db.insert(membershipSource).values({
      id: crypto.randomUUID(),
      orgId,
      membershipId: membership.id,
      kind: 'scim',
      identityConnectionId: connection.id,
      ref: 'scim-user',
    })
    return { userId, connectionId: connection.id }
  }

  describe('the admin check', () => {
    it('lists every registered admin route', () => {
      const registered = (harness.app as unknown as { routes: { method: string; path: string }[] }).routes
        .filter((route) => route.path.startsWith('/v1/admin/'))
        .map((route) => `${route.method} ${route.path}`)
        .sort()
      expect(registered).toEqual(adminRoutes.map((route) => `${route.method} ${route.path}`).sort())
    })

    it.each(adminRoutes.map((route) => [`${route.method} ${route.path}`, route] as const))(
      'refuses %s to a member who is not an admin, records it, and changes nothing',
      async (_, route) => {
        const configRows = async () =>
          Promise.all([
            harness.db.$count(localGroup),
            harness.db.$count(orgDomain),
            harness.db.$count(invitation),
            harness.db.$count(identityConnection),
            harness.db.$count(memberRoleGrant),
            harness.db.$count(linkReview),
          ])
        const before = await configRows()
        const earlierEvents = await harness.db.$count(auditEvent)

        const response = await call(route.method, fillPath(route.path), route.body)

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ code: 'ADMIN_REQUIRED' })
        expect(await harness.db.$count(auditEvent)).toBe(earlierEvents + 1)
        expect(
          (await harness.db.select().from(auditEvent).where(eq(auditEvent.action, 'admin.access_denied'))).map(
            (event) => ({
              action: event.action,
              outcome: event.outcome,
              actorId: event.actorId,
              metadata: event.metadata,
            }),
          ),
        ).toEqual([
          {
            action: 'admin.access_denied',
            outcome: 'denied',
            actorId: adminId,
            metadata: { method: route.method, path: fillPath(route.path) },
          },
        ])
        expect(await configRows()).toEqual(before)
      },
    )

    it('answers 401 without a session, and records nothing', async () => {
      expect((await call('GET', '/v1/admin/members', undefined, {})).status).toBe(401)
      expect(await harness.db.$count(auditEvent, eq(auditEvent.action, 'admin.access_denied'))).toBe(0)
    })

    it("refuses an admin's request from a browser origin we don't serve, and changes nothing", async () => {
      await grantAdmin(adminId)
      const from = (origin: string) =>
        call('POST', '/v1/admin/groups', { name: 'Finance' }, { ...authHeaders(harness.bearerToken), origin })

      const refused = await from('https://evil.example')
      expect(refused.status).toBe(403)
      expect(await json(refused)).toEqual({ code: 'ORIGIN_NOT_ALLOWED' })
      expect(await harness.db.$count(localGroup)).toBe(0)

      expect((await from('http://localhost:1420')).status).toBe(200)
      expect(await harness.db.$count(localGroup)).toBe(1)
    })

    it('answers a blocked admin 401: the block signs them out before the admin check runs', async () => {
      await grantAdmin(adminId)
      await harness.db.update(orgMembership).set({ blockedAt: new Date() }).where(eq(orgMembership.userId, adminId))

      expect((await call('GET', '/v1/admin/members')).status).toBe(401)
    })

    it('validates the request before the admin check: a malformed body from a non-admin is a 422 and records nothing', async () => {
      expect((await call('POST', '/v1/admin/groups', {})).status).toBe(422)
      expect(await harness.db.$count(auditEvent, eq(auditEvent.action, 'admin.access_denied'))).toBe(0)
    })
  })

  describe('as an admin', () => {
    beforeEach(async () => {
      await grantAdmin(adminId)
    })

    describe('members', () => {
      it('lists members with their sources, roles and what an IdP manages, one page at a time', async () => {
        const local = await addMember('a-local@example.com')
        const { userId: managed, connectionId } = await addIdpManagedMember()

        const first = await json<{ items: { userId: string }[]; nextCursor: string }>(
          await call('GET', '/v1/admin/members?limit=2'),
        )
        expect(first.items).toHaveLength(2)
        const rest = await json<{ items: { userId: string }[]; nextCursor: string | null }>(
          await call('GET', `/v1/admin/members?limit=2&cursor=${first.nextCursor}`),
        )
        expect(rest).toMatchObject({ nextCursor: null })
        expect(new Set([...first.items, ...rest.items].map((member) => member.userId))).toEqual(
          new Set([adminId, local, managed]),
        )

        expect(await json(await call('GET', `/v1/admin/members/${managed}`))).toMatchObject({
          access: { allowed: true },
          sources: [{ kind: 'scim', status: 'active', connection: { id: connectionId } }],
          idpManaged: {
            connections: [{ id: connectionId }],
            fields: ['email', 'name', 'scimGroups', 'scimRoles', 'status'],
          },
        })
        expect(await json(await call('GET', `/v1/admin/members/${adminId}`))).toMatchObject({
          idpManaged: null,
          roles: [{ role: 'admin', from: 'local' }],
        })
        expect(await json(await call('GET', '/v1/admin/members?q=A-LOCAL'))).toMatchObject({
          items: [{ userId: local }],
        })
        expect((await call('GET', '/v1/admin/members?cursor=nonsense')).status).toBe(400)
        expect((await call('GET', '/v1/admin/members/nobody')).status).toBe(404)
      })

      it('renames a local member, and refuses the name of one an IdP manages with the reason', async () => {
        const local = await addMember()
        const { userId: managed, connectionId } = await addIdpManagedMember()

        expect(await json(await call('PATCH', `/v1/admin/members/${local}`, { name: 'Ada' }))).toMatchObject({
          name: 'Ada',
        })
        expect(await events('member.updated')).toMatchObject([{ targetId: local, metadata: { fields: ['name'] } }])

        const refused = await call('PATCH', `/v1/admin/members/${managed}`, { name: 'Ada' })
        expect(refused.status).toBe(409)
        expect(await refused.json()).toMatchObject({
          code: 'FIELD_MANAGED_BY_IDP',
          field: 'name',
          managedBy: [connectionId],
        })
        const [row] = await harness.db.select({ name: user.name }).from(user).where(eq(user.id, managed))
        expect(row.name).toBe('Employee')
        expect(await events('member.updated', 'denied')).toMatchObject([
          { targetId: managed, reason: 'FIELD_MANAGED_BY_IDP', actorId: adminId },
        ])
        expect((await call('PATCH', `/v1/admin/members/${local}`, { email: 'new@example.com' })).status).toBe(422)
      })

      it('blocks a member: their sessions go, with one event each; unblocking lifts it', async () => {
        const target = await addMember()
        const sessionId = crypto.randomUUID()
        await harness.db.insert(session).values({
          id: sessionId,
          userId: target,
          token: crypto.randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        })

        const blocked = await call('POST', `/v1/admin/members/${target}/block`, { reason: 'Left the company' })
        expect(blocked.status).toBe(200)
        expect(await blocked.json()).toMatchObject({
          access: { allowed: false, reason: 'blocked' },
          blocked: { by: adminId, reason: 'Left the company' },
        })
        expect(await harness.db.$count(session, eq(session.userId, target))).toBe(0)
        expect(await events('auth.session_revoked')).toMatchObject([
          { actorId: adminId, targetType: 'user', targetId: target, metadata: { sessionId, reason: 'member_blocked' } },
        ])
        expect(await events('member.blocked')).toHaveLength(1)

        await call('POST', `/v1/admin/members/${target}/block`, {})
        expect(await events('member.blocked')).toHaveLength(1)

        expect(await json(await call('POST', `/v1/admin/members/${target}/unblock`))).toMatchObject({
          access: { allowed: true },
          blocked: null,
        })
        expect(await events('member.unblocked')).toHaveLength(1)
      })

      it('refuses an admin blocking themselves, and records the attempt', async () => {
        const response = await call('POST', `/v1/admin/members/${adminId}/block`, {})

        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'BLOCK_SELF' })
        expect((await membershipOf(adminId)).blockedAt).toBeNull()
        expect(await events('member.blocked', 'denied')).toMatchObject([{ reason: 'BLOCK_SELF', targetId: adminId }])
      })

      it('grants and revokes local roles, refuses unknown ones, and warns when no local admin is left', async () => {
        const other = await addMember()

        expect((await call('POST', `/v1/admin/members/${other}/roles`, { role: 'member' })).status).toBe(422)
        expect((await call('POST', `/v1/admin/members/${other}/roles`, { role: 'owner' })).status).toBe(422)
        expect(await json(await call('POST', `/v1/admin/members/${other}/roles`, { role: 'admin' }))).toMatchObject({
          roles: [{ role: 'admin', from: 'local' }],
        })
        expect(await events('member.role_granted')).toMatchObject([{ targetId: other, metadata: { role: 'admin' } }])

        const revokedOther = await json(await call('DELETE', `/v1/admin/members/${other}/roles/admin`))
        expect(revokedOther).toMatchObject({ roles: [] })
        expect(revokedOther.warning).toBeUndefined()

        // Self-demotion is allowed; with no other admin left, the response warns.
        expect(await json(await call('DELETE', `/v1/admin/members/${adminId}/roles/admin`))).toMatchObject({
          warning: 'NO_LOCAL_ADMIN',
        })
      })

      it('refuses to revoke a role held only through a local group, naming the group', async () => {
        const other = await addMember()
        const group = await json<{ id: string }>(await call('POST', '/v1/admin/groups', { name: 'Admins' }))
        await call('POST', '/v1/admin/role-mappings', { localGroupId: group.id, role: 'admin' })
        await call('POST', `/v1/admin/groups/${group.id}/members`, { userId: other })

        const response = await call('DELETE', `/v1/admin/members/${other}/roles/admin`)

        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'ROLE_FROM_LOCAL_GROUP', groupIds: [group.id] })
        expect(await events('member.role_revoked', 'denied')).toMatchObject([{ reason: 'ROLE_FROM_LOCAL_GROUP' }])
      })

      it('purges a blocked member, and records the refusal for one who still has access', async () => {
        const target = await addMember()

        const refused = await call('DELETE', `/v1/admin/members/${target}`)
        expect(refused.status).toBe(409)
        expect(await refused.json()).toMatchObject({ code: 'MEMBER_HAS_ACCESS' })
        expect(await events('member.purged', 'denied')).toMatchObject([{ reason: 'MEMBER_HAS_ACCESS' }])

        const self = await call('DELETE', `/v1/admin/members/${adminId}`)
        expect(self.status).toBe(400)
        expect(await events('member.purged', 'denied')).toHaveLength(2)

        await call('POST', `/v1/admin/members/${target}/block`, {})
        expect((await call('DELETE', `/v1/admin/members/${target}`)).status).toBe(204)
        expect(await harness.db.$count(user, eq(user.id, target))).toBe(0)
        expect(await events('member.purged')).toHaveLength(1)
      })

      it('flags break-glass when every admin needs SSO, counting a SCIM-only admin as local', async () => {
        expect(await json(await call('GET', '/v1/admin/break-glass'))).toEqual({
          allAdminsIdpManaged: false,
          adminCount: 1,
          localAdminCount: 1,
        })

        const { userId: scimOnly } = await addIdpManagedMember()
        await grantAdmin(scimOnly)
        const { userId: ssoManaged } = await addIdpManagedMember({ sso: true })
        await grantAdmin(ssoManaged)
        await harness.db
          .delete(memberRoleGrant)
          .where(eq(memberRoleGrant.membershipId, (await membershipOf(adminId)).id))
        // The harness user is no longer an admin, so read the flag the way the route does. A SCIM-only
        // connection leaves email-code sign-in open, so that admin can still get in.
        expect(await getBreakGlassStatus(harness.db)).toEqual({
          allAdminsIdpManaged: false,
          adminCount: 2,
          localAdminCount: 1,
        })

        await harness.db
          .delete(memberRoleGrant)
          .where(eq(memberRoleGrant.membershipId, (await membershipOf(scimOnly)).id))
        expect(await getBreakGlassStatus(harness.db)).toEqual({
          allAdminsIdpManaged: true,
          adminCount: 1,
          localAdminCount: 0,
        })
      })
    })

    describe('detaching an IdP link', () => {
      /** A connection with SSO and SCIM sides, as the tables hold them; `status` is the connection's. */
      const addConnection = async (status: 'active' | 'scim_retired' = 'active') => {
        const providerId = `idp-${crypto.randomUUID()}`
        const [provider] = await harness.db
          .insert(ssoProvider)
          .values({ id: crypto.randomUUID(), providerId, issuer: `https://${providerId}.test`, domain: '' })
          .returning()
        const [connection] = await harness.db
          .insert(identityConnection)
          .values({
            id: crypto.randomUUID(),
            orgId,
            name: `IdP ${providerId}`,
            ssoProviderId: provider.id,
            scimConnectionId: crypto.randomUUID(),
            status,
          })
          .returning()
        return { ...connection, providerId, scimConnectionId: connection.scimConnectionId! }
      }

      type Connection = Awaited<ReturnType<typeof addConnection>>

      /** Link a member to a connection: sources of the given kinds, an SSO account and a SCIM tombstone. */
      const link = async (
        userId: string,
        connection: Connection,
        sources: { kind: 'scim' | 'sso'; status: 'active' | 'suspended' | 'removed' }[],
      ) => {
        const membershipId = (await membershipOf(userId)).id
        for (const source of sources) {
          await harness.db
            .insert(membershipSource)
            .values({ id: crypto.randomUUID(), orgId, membershipId, identityConnectionId: connection.id, ...source })
        }
        await harness.db.insert(account).values({
          id: crypto.randomUUID(),
          accountId: `subject-${crypto.randomUUID()}`,
          providerId: connection.providerId,
          userId,
          updatedAt: new Date(),
        })
        const externalId = crypto.randomUUID()
        await harness.db.insert(scimIdentityTombstone).values({
          id: crypto.randomUUID(),
          connectionId: connection.scimConnectionId,
          provisioningDomainId: orgId,
          externalId,
          externalIdKey: `${connection.scimConnectionId}:${externalId}`,
          userId,
          profile: 'manage',
          deletedAt: new Date(),
        })
      }

      /** Everything a link to `connection` holds for `userId`. */
      const linkRows = async (userId: string, connection: Connection) => ({
        sources: (
          await harness.db
            .select({ kind: membershipSource.kind, status: membershipSource.status })
            .from(membershipSource)
            .where(
              and(
                eq(membershipSource.membershipId, (await membershipOf(userId)).id),
                eq(membershipSource.identityConnectionId, connection.id),
              ),
            )
        ).sort((a, b) => a.kind.localeCompare(b.kind)),
        accounts: await harness.db.$count(
          account,
          and(eq(account.userId, userId), eq(account.providerId, connection.providerId)),
        ),
        tombstones: await harness.db.$count(
          scimIdentityTombstone,
          and(
            eq(scimIdentityTombstone.userId, userId),
            eq(scimIdentityTombstone.connectionId, connection.scimConnectionId),
          ),
        ),
      })

      const detach = (userId: string, connectionId: string) =>
        call('POST', `/v1/admin/members/${userId}/connections/${connectionId}/detach`)

      it('detaches a link the IdP deleted: the local grant decides again, other connections stay', async () => {
        // An invitation admits the member locally; the IdP's removed source still manages them.
        const userId = await addMember()
        const [connection, other] = [await addConnection(), await addConnection()]
        await link(userId, connection, [
          { kind: 'scim', status: 'removed' },
          { kind: 'sso', status: 'active' },
        ])
        await link(userId, other, [{ kind: 'scim', status: 'removed' }])
        const otherBefore = await linkRows(userId, other)

        const response = await detach(userId, connection.id)

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          access: { allowed: false, reason: 'deprovisioned' },
          idpManaged: { connections: [{ id: other.id }] },
        })
        expect(await linkRows(userId, connection)).toEqual({ sources: [], accounts: 0, tombstones: 0 })
        expect(await linkRows(userId, other)).toEqual(otherBefore)
        expect(await events('link.detached')).toMatchObject([
          {
            actorId: adminId,
            targetId: userId,
            connectionId: connection.id,
            metadata: { sourceStatus: 'removed', kinds: ['scim', 'sso'], accountsRemoved: 1, tombstoneCleared: true },
          },
        ])

        expect((await detach(userId, other.id)).status).toBe(200)
        expect(await json(await call('GET', `/v1/admin/members/${userId}`))).toMatchObject({
          access: { allowed: true },
          idpManaged: null,
          requiresSso: false,
        })
      })

      it.each([
        ['active', 'LINK_SOURCE_ACTIVE'],
        ['suspended', 'LINK_SOURCE_SUSPENDED'],
      ] as const)('refuses a %s SCIM source with %s, records it, and changes nothing', async (status, code) => {
        const userId = await addMember()
        const connection = await addConnection()
        await link(userId, connection, [{ kind: 'scim', status }])
        const before = await linkRows(userId, connection)

        const response = await detach(userId, connection.id)

        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code })
        expect(await linkRows(userId, connection)).toEqual(before)
        expect(await events('link.detached', 'denied')).toMatchObject([
          { actorId: adminId, targetId: userId, reason: code },
        ])
      })

      it('detaches an active SCIM source the access check ignores, on a retired SCIM side', async () => {
        const userId = await addMember()
        const connection = await addConnection('scim_retired')
        await link(userId, connection, [{ kind: 'scim', status: 'active' }])

        expect((await detach(userId, connection.id)).status).toBe(200)
        expect(await linkRows(userId, connection)).toEqual({ sources: [], accounts: 0, tombstones: 0 })
        expect(await events('link.detached')).toMatchObject([{ metadata: { sourceStatus: 'active' } }])
      })

      it('refuses an admin detaching their own link, and records it', async () => {
        const connection = await addConnection('scim_retired')
        await link(adminId, connection, [
          { kind: 'scim', status: 'active' },
          { kind: 'sso', status: 'active' },
        ])
        const before = await linkRows(adminId, connection)

        const response = await detach(adminId, connection.id)

        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'DETACH_SELF' })
        expect(await linkRows(adminId, connection)).toEqual(before)
        expect(await events('link.detached', 'denied')).toMatchObject([
          { actorId: adminId, targetId: adminId, reason: 'DETACH_SELF' },
        ])
      })

      it('refuses a link with no SCIM source, and answers 404 for a missing link or member', async () => {
        const userId = await addMember()
        const [ssoOnly, unlinked] = [await addConnection(), await addConnection()]
        await link(userId, ssoOnly, [{ kind: 'sso', status: 'active' }])

        const refused = await detach(userId, ssoOnly.id)
        expect(refused.status).toBe(409)
        expect(await refused.json()).toMatchObject({ code: 'LINK_NOT_DETACHABLE' })
        expect(await linkRows(userId, ssoOnly)).toMatchObject({ sources: [{ kind: 'sso' }], accounts: 1 })

        for (const [member, connectionId] of [
          [userId, unlinked.id],
          [userId, 'no-such-connection'],
          ['nobody', ssoOnly.id],
        ]) {
          const missing = await detach(member, connectionId)
          expect(missing.status).toBe(404)
        }
        expect(await events('link.detached', 'denied')).toMatchObject([{ reason: 'LINK_NOT_DETACHABLE' }])
      })
    })

    describe('local groups and role mappings', () => {
      it('creates, renames, lists and deletes a group, with an event for each', async () => {
        const created = await json<{ id: string }>(
          await call('POST', '/v1/admin/groups', { name: 'Finance', description: 'Money' }),
        )
        const taken = await call('POST', '/v1/admin/groups', { name: 'FINANCE' })
        expect(taken.status).toBe(409)
        expect(await taken.json()).toMatchObject({ code: 'GROUP_NAME_TAKEN' })

        expect(await json(await call('PATCH', `/v1/admin/groups/${created.id}`, { name: 'Treasury' }))).toMatchObject({
          name: 'Treasury',
          description: 'Money',
          memberCount: 0,
        })
        expect(await json(await call('GET', '/v1/admin/groups'))).toMatchObject({
          items: [{ id: created.id, name: 'Treasury' }],
          nextCursor: null,
        })
        expect(await json(await call('DELETE', `/v1/admin/groups/${created.id}`))).toEqual({})
        expect((await call('GET', `/v1/admin/groups/${created.id}`)).status).toBe(404)

        expect(await events('local_group.created')).toHaveLength(1)
        expect(await events('local_group.updated')).toMatchObject([
          { changes: { name: { from: 'Finance', to: 'Treasury' } } },
        ])
        expect(await events('local_group.deleted')).toHaveLength(1)
        expect(await harness.db.$count(auditEvent, ne(auditEvent.outcome, 'success'))).toBe(0)
      })

      it('adds and removes members, and grants a mapped group’s role to them', async () => {
        const member = await addMember()
        const group = await json<{ id: string }>(await call('POST', '/v1/admin/groups', { name: 'Ops' }))
        const mapping = await json<{ id: string; target: unknown }>(
          await call('POST', '/v1/admin/role-mappings', { localGroupId: group.id, role: 'admin' }),
        )
        expect(mapping.target).toEqual({ kind: 'local_group', groupId: group.id, name: 'Ops' })
        const again = await call('POST', '/v1/admin/role-mappings', { localGroupId: group.id, role: 'admin' })
        expect(again.status).toBe(409)
        expect(await events('group_role_mapping.created', 'denied')).toHaveLength(0)

        expect((await call('POST', `/v1/admin/groups/${group.id}/members`, { userId: member })).status).toBe(204)
        expect((await call('POST', `/v1/admin/groups/${group.id}/members`, { userId: member })).status).toBe(204)
        expect(await events('local_group.member_added')).toHaveLength(1)
        expect(await json(await call('GET', `/v1/admin/groups/${group.id}/members`))).toMatchObject({
          items: [{ userId: member }],
        })
        expect(await json(await call('GET', `/v1/admin/members/${member}`))).toMatchObject({
          roles: [{ role: 'admin', from: 'local_group', groupId: group.id }],
        })

        expect(await json(await call('DELETE', `/v1/admin/groups/${group.id}/members/${member}`))).toEqual({})
        expect(await json(await call('GET', `/v1/admin/members/${member}`))).toMatchObject({ roles: [] })
        expect(await json(await call('DELETE', `/v1/admin/role-mappings/${mapping.id}`))).toEqual({})
        expect(await harness.db.$count(groupRoleMapping)).toBe(0)
        expect(await events('group_role_mapping.deleted')).toHaveLength(1)
        expect((await call('POST', `/v1/admin/groups/${group.id}/members`, { userId: 'nobody' })).status).toBe(404)
      })

      it('warns when removing the group that made the only admin one', async () => {
        const group = await json<{ id: string }>(await call('POST', '/v1/admin/groups', { name: 'Admins' }))
        await call('POST', '/v1/admin/role-mappings', { localGroupId: group.id, role: 'admin' })
        await call('POST', `/v1/admin/groups/${group.id}/members`, { userId: adminId })
        await harness.db.delete(memberRoleGrant)

        expect(await json(await call('DELETE', `/v1/admin/groups/${group.id}/members/${adminId}`))).toEqual({
          warning: 'NO_LOCAL_ADMIN',
        })
      })

      it('records each role mapping a group delete takes with it, and the members it affected', async () => {
        const member = await addMember()
        const group = await json<{ id: string }>(await call('POST', '/v1/admin/groups', { name: 'Admins' }))
        const mapping = await json<{ id: string }>(
          await call('POST', '/v1/admin/role-mappings', { localGroupId: group.id, role: 'admin' }),
        )
        await call('POST', `/v1/admin/groups/${group.id}/members`, { userId: member })

        expect((await call('DELETE', `/v1/admin/groups/${group.id}`)).status).toBe(200)

        expect(await harness.db.$count(groupRoleMapping)).toBe(0)
        expect(await events('group_role_mapping.deleted')).toMatchObject([
          {
            targetId: mapping.id,
            actorId: adminId,
            metadata: { localGroupId: group.id, role: 'admin', reason: 'local_group_deleted' },
          },
        ])
        expect(await events('local_group.deleted')).toMatchObject([
          { targetId: group.id, metadata: { name: 'Admins', memberCount: 1, roles: ['admin'] } },
        ])
        expect(await json(await call('GET', `/v1/admin/members/${member}`))).toMatchObject({ roles: [] })
      })

      it('does not treat a SCIM group id as a local group', async () => {
        expect((await call('GET', '/v1/admin/groups/scim-group-id/members')).status).toBe(404)
        expect(
          (
            await call('POST', '/v1/admin/role-mappings', {
              identityConnectionId: 'nope',
              scimGroupId: 'g',
              role: 'admin',
            })
          ).status,
        ).toBe(404)
      })
    })

    describe('domains', () => {
      it('turns enrollment off when a domain is claimed, so an unclaim leaves it closed', async () => {
        const [connection] = await harness.db
          .insert(identityConnection)
          .values({ id: crypto.randomUUID(), orgId, name: 'Entra' })
          .returning()
        const added = await json<{ id: string }>(await call('POST', '/v1/admin/domains', { domain: 'open.test' }))
        await harness.db.update(orgDomain).set({ verifiedAt: new Date() }).where(eq(orgDomain.id, added.id))
        expect(
          await json(await call('PUT', `/v1/admin/domains/${added.id}/enrollment`, { enabled: true })),
        ).toMatchObject({ enrollmentEnabled: true })

        expect(
          await json(await call('PUT', `/v1/admin/domains/${added.id}/claim`, { identityConnectionId: connection.id })),
        ).toMatchObject({ enrollmentEnabled: false })
        expect(await events('domain.claimed')).toMatchObject([
          { changes: { enrollmentEnabled: { from: true, to: false } } },
        ])
        expect(await json(await call('DELETE', `/v1/admin/domains/${added.id}/claim`))).toMatchObject({
          claimedBy: null,
          enrollmentEnabled: false,
        })
      })

      it('adds, verifies by DNS-free fixture, claims, unclaims and removes a domain, refusing what policy forbids', async () => {
        const [connection] = await harness.db
          .insert(identityConnection)
          .values({ id: crypto.randomUUID(), orgId, name: 'Entra' })
          .returning()
        const added = await json<{ id: string; record: { name: string } }>(
          await call('POST', '/v1/admin/domains', { domain: 'Corp.Test' }),
        )
        expect(added.record.name).toBe('_thunderbolt-verification.corp.test')
        const duplicate = await call('POST', '/v1/admin/domains', { domain: 'corp.test' })
        expect(duplicate.status).toBe(409)
        expect(await duplicate.json()).toMatchObject({ code: 'DOMAIN_EXISTS' })

        const unverified = await call('PUT', `/v1/admin/domains/${added.id}/claim`, {
          identityConnectionId: connection.id,
        })
        expect(unverified.status).toBe(409)
        expect(await events('domain.claimed', 'denied')).toMatchObject([{ reason: 'DOMAIN_NOT_VERIFIED' }])

        await harness.db.update(orgDomain).set({ verifiedAt: new Date() }).where(eq(orgDomain.id, added.id))
        expect(
          await json(await call('PUT', `/v1/admin/domains/${added.id}/claim`, { identityConnectionId: connection.id })),
        ).toMatchObject({ claimedBy: { id: connection.id, name: 'Entra' } })
        expect(await events('domain.claimed')).toMatchObject([{ connectionId: connection.id }])
        expect((await call('PUT', `/v1/admin/domains/${added.id}/enrollment`, { enabled: true })).status).toBe(409)
        expect(
          (await call('PUT', `/v1/admin/domains/${added.id}/claim`, { identityConnectionId: crypto.randomUUID() }))
            .status,
        ).toBe(409)
        expect(await json(await call('GET', '/v1/admin/connections'))).toMatchObject({
          items: [{ id: connection.id, claimedDomains: ['corp.test'] }],
        })

        const claimedRemove = await call('DELETE', `/v1/admin/domains/${added.id}`)
        expect(claimedRemove.status).toBe(409)
        expect(await events('domain.removed', 'denied')).toMatchObject([{ reason: 'DOMAIN_CLAIMED_BY_IDP' }])

        expect(await json(await call('DELETE', `/v1/admin/domains/${added.id}/claim`))).toMatchObject({
          claimedBy: null,
        })
        expect(await events('domain.unclaimed')).toHaveLength(1)
        expect((await call('DELETE', `/v1/admin/domains/${added.id}`)).status).toBe(204)
        expect(await harness.db.$count(orgDomain)).toBe(0)
        expect(await events('domain.removed')).toMatchObject([{ metadata: { domain: 'corp.test' } }])
      })
    })

    describe('invitations', () => {
      it('pages through a burst of invitations within one millisecond without skipping any', async () => {
        // Postgres keeps microseconds; these rows share a millisecond, and two share a timestamp.
        const stamps = ['123001', '123002', '123002', '123003', '123004']
        const ids = stamps.map(() => crypto.randomUUID())
        await harness.db.insert(invitation).values(
          stamps.map((micros, index) => ({
            id: ids[index],
            orgId,
            email: `burst-${index}@example.org`,
            tokenHash: crypto.randomUUID(),
            expiresAt: new Date(Date.now() + 60_000),
            createdAt: sql`${`2026-11-14 10:00:00.${micros}`}::timestamp`,
          })),
        )

        const seen: string[] = []
        let cursor: string | null = null
        do {
          const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2'
          const page = await json<{ items: { id: string }[]; nextCursor: string | null }>(
            await call('GET', `/v1/admin/invitations${query}`),
          )
          seen.push(...page.items.map((item) => item.id))
          cursor = page.nextCursor
        } while (cursor)

        expect(seen).toHaveLength(5)
        expect(new Set(seen)).toEqual(new Set(ids))
      })

      it('searches invitations by part of the email, matching % and _ literally', async () => {
        for (const email of ['ada@corp.test', 'grace@corp.test', 'ada_100%@corp.test']) {
          await call('POST', '/v1/admin/invitations', { email })
        }
        const search = async (q: string) =>
          (
            await json<{ items: { email: string }[] }>(
              await call('GET', `/v1/admin/invitations?q=${encodeURIComponent(q)}`),
            )
          ).items
            .map((item) => item.email)
            .sort()

        expect(await search('ADA')).toEqual(['ada@corp.test', 'ada_100%@corp.test'])
        expect(await search('_100%')).toEqual(['ada_100%@corp.test'])
        expect((await call('GET', '/v1/admin/invitations?q=')).status).toBe(422)
      })

      it('answers a malformed invitation cursor with 400', async () => {
        const bad = Buffer.from(JSON.stringify(['not a time', 'id'])).toString('base64url')
        for (const cursor of ['nonsense', bad]) {
          const response = await call('GET', `/v1/admin/invitations?cursor=${cursor}`)
          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({ code: 'INVALID_CURSOR' })
        }
      })

      it('invites, lists without the token hash, and revokes', async () => {
        const created = await json<{ id: string }>(
          await call('POST', '/v1/admin/invitations', { email: 'Contractor@Example.org' }),
        )
        const page = await json<{ items: Record<string, unknown>[] }>(await call('GET', '/v1/admin/invitations'))
        expect(page.items).toMatchObject([{ id: created.id, email: 'contractor@example.org', status: 'pending' }])
        expect(page.items[0]).not.toHaveProperty('tokenHash')

        expect((await call('POST', `/v1/admin/invitations/${created.id}/revoke`)).status).toBe(204)
        expect(await json(await call('GET', '/v1/admin/invitations?status=revoked'))).toMatchObject({
          items: [{ id: created.id }],
        })
        expect((await call('POST', `/v1/admin/invitations/${created.id}/revoke`)).status).toBe(404)

        const existing = await call('POST', '/v1/admin/invitations', { email: harness.email })
        expect(existing.status).toBe(409)
        expect(await existing.json()).toEqual({ code: 'ALREADY_MEMBER' })
      })
    })

    describe('link reviews', () => {
      const addReview = async (candidateUserId: string) => {
        const [connection] = await harness.db
          .insert(identityConnection)
          .values({ id: crypto.randomUUID(), orgId, name: `Entra ${crypto.randomUUID()}` })
          .returning()
        const [review] = await harness.db
          .insert(linkReview)
          .values({
            id: crypto.randomUUID(),
            orgId,
            identityConnectionId: connection.id,
            trigger: 'scim_create_conflict',
            externalId: crypto.randomUUID(),
            incomingEmail: 'incoming@example.com',
            candidateUserId,
          })
          .returning()
        return review
      }

      it('lists reviews with the candidate and connection, and approves and rejects them', async () => {
        const candidate = await addMember()
        const toApprove = await addReview(candidate)
        const toReject = await addReview(candidate)

        const page = await json<{ reviews: { id: string; candidate: { id: string } }[]; nextCursor: string | null }>(
          await call('GET', '/v1/admin/link-reviews?status=pending'),
        )
        expect(page.reviews.map((review) => review.id).sort()).toEqual([toApprove.id, toReject.id].sort())
        expect(page.reviews[0].candidate.id).toBe(candidate)

        expect(await json(await call('POST', `/v1/admin/link-reviews/${toApprove.id}/approve`))).toMatchObject({
          status: 'approved',
          resolvedBy: adminId,
        })
        expect(await json(await call('POST', `/v1/admin/link-reviews/${toReject.id}/reject`))).toMatchObject({
          status: 'rejected',
        })
        expect(await events('link_review.approved')).toMatchObject([{ targetId: toApprove.id, actorId: adminId }])
        expect(await events('link_review.rejected')).toMatchObject([{ targetId: toReject.id, actorId: adminId }])

        const again = await call('POST', `/v1/admin/link-reviews/${toReject.id}/reject`)
        expect(again.status).toBe(409)
        expect(await events('link_review.rejected', 'denied')).toMatchObject([{ reason: 'LINK_REVIEW_RESOLVED' }])
        expect((await call('POST', '/v1/admin/link-reviews/nope/approve')).status).toBe(404)
      })

      it('refuses an admin approving a link to their own account, and records the attempt', async () => {
        const review = await addReview(adminId)

        const response = await call('POST', `/v1/admin/link-reviews/${review.id}/approve`)

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ code: 'LINK_REVIEW_SELF' })
        expect(await events('link_review.approved', 'denied')).toMatchObject([
          { reason: 'LINK_REVIEW_SELF', actorId: adminId, targetId: review.id },
        ])
        const [row] = await harness.db.select().from(linkReview).where(eq(linkReview.id, review.id))
        expect(row.status).toBe('pending')
      })

      it('answers a malformed cursor with 400, and records nothing', async () => {
        const response = await call('GET', '/v1/admin/link-reviews?cursor=nonsense')

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ code: 'LINK_REVIEW_INVALID_CURSOR' })
        expect(await harness.db.$count(auditEvent, ne(auditEvent.outcome, 'success'))).toBe(0)
      })
    })

    describe('connections', () => {
      it('creates an SSO connection without ever returning its secret, and retires it', async () => {
        const created = await call('POST', '/v1/admin/connections/sso', oidcBody('okta'))
        expect(created.status).toBe(200)
        const connection = await json<{ id: string }>(created)
        expect(connection).toMatchObject({
          sso: { providerId: 'okta', protocol: 'oidc', issuer: 'https://okta.test', envOwned: false },
          scim: null,
          status: 'active',
        })
        expect(JSON.stringify(await json(await call('GET', '/v1/admin/connections')))).not.toContain('top-secret')

        const taken = await call('POST', '/v1/admin/connections/sso', oidcBody('okta'))
        expect(taken.status).toBe(409)
        expect(await taken.json()).toMatchObject({ code: 'SSO_PROVIDER_ID_TAKEN' })
        expect((await call('POST', '/v1/admin/connections/sso', oidcBody('sso'))).status).toBe(400)
        expect(await events('connection.created', 'denied')).toHaveLength(0)

        expect(await json(await call('POST', `/v1/admin/connections/${connection.id}/retire`))).toMatchObject({
          status: 'retired',
        })
        expect(await events('connection.retired')).toMatchObject([{ connectionId: connection.id }])
        expect((await call('POST', `/v1/admin/connections/${connection.id}/retire`)).status).toBe(404)
      })

      it('refuses to retire the env connection or one whose SCIM side is live, and records it', async () => {
        const [provider] = await harness.db
          .insert(ssoProvider)
          .values({ id: crypto.randomUUID(), providerId: 'sso', issuer: 'https://env.test', domain: '' })
          .returning()
        await harness.db
          .insert(identityConnection)
          .values({ id: envSsoConnectionId, orgId, name: 'Company SSO', ssoProviderId: provider.id })
        const both = await json<{ id: string }>(await call('POST', '/v1/admin/connections/sso', oidcBody('entra')))
        await harness.db
          .update(identityConnection)
          .set({ scimConnectionId: crypto.randomUUID() })
          .where(eq(identityConnection.id, both.id))

        const env = await call('POST', `/v1/admin/connections/${envSsoConnectionId}/retire`)
        expect(env.status).toBe(409)
        expect(await env.json()).toMatchObject({ code: 'SSO_CONNECTION_ENV_OWNED' })
        const live = await call('POST', `/v1/admin/connections/${both.id}/retire`)
        expect(live.status).toBe(409)
        expect(await live.json()).toMatchObject({ code: 'SCIM_SIDE_NOT_RETIRED' })
        expect((await events('connection.retired', 'denied')).map((event) => event.reason).sort()).toEqual([
          'SCIM_SIDE_NOT_RETIRED',
          'SSO_CONNECTION_ENV_OWNED',
        ])
      })

      describe('editing an SSO connection', () => {
        const samlBody = (providerId: string) => ({
          name: `IdP ${providerId}`,
          providerId,
          protocol: {
            saml: {
              entityId: 'thunderbolt-sp',
              entryPoint: `https://${providerId}.test/sso`,
              cert: 'first-cert',
              idpIssuer: `https://${providerId}.test`,
            },
          },
        })

        const create = async (body: unknown) =>
          (await json<{ id: string }>(await call('POST', '/v1/admin/connections/sso', body))).id

        const storedConfig = async (providerId: string) => {
          const [row] = await harness.db.select().from(ssoProvider).where(eq(ssoProvider.providerId, providerId))
          return JSON.parse((row.oidcConfig ?? row.samlConfig)!) as Record<string, unknown>
        }

        const edit = (connectionId: string, body: unknown) =>
          call('PATCH', `/v1/admin/connections/${connectionId}`, body)

        const linkAccount = (providerId: string) =>
          harness.db.insert(account).values({
            id: crypto.randomUUID(),
            accountId: `subject-${crypto.randomUUID()}`,
            providerId,
            userId: adminId,
            updatedAt: new Date(),
          })

        it('renames and replaces an OIDC secret, merging the config, naming only the fields it changed', async () => {
          const connectionId = await create(oidcBody('okta'))
          const before = await storedConfig('okta')

          const response = await edit(connectionId, { name: 'Okta', oidc: { clientSecret: 'rotated-secret' } })

          expect(response.status).toBe(200)
          const text = await response.text()
          expect(JSON.parse(text)).toMatchObject({ name: 'Okta', sso: { providerId: 'okta', protocol: 'oidc' } })
          expect(text).not.toContain('secret')
          expect(await storedConfig('okta')).toEqual({ ...before, clientSecret: 'rotated-secret' })
          const [updated] = await events('connection.updated')
          expect(updated).toMatchObject({
            actorId: adminId,
            connectionId,
            metadata: { side: 'sso', providerId: 'okta', changedFields: ['name', 'oidcConfig.clientSecret'] },
          })
          expect(JSON.stringify(updated)).not.toContain('rotated-secret')

          // The same values again change nothing and record nothing.
          expect((await edit(connectionId, { name: 'Okta', oidc: { clientSecret: 'rotated-secret' } })).status).toBe(
            200,
          )
          expect(await events('connection.updated')).toHaveLength(1)
        })

        it('replaces a SAML certificate and entry point, keeping what names both sides', async () => {
          const connectionId = await create(samlBody('adfs'))
          const before = await storedConfig('adfs')

          const response = await edit(connectionId, {
            saml: { cert: 'second-cert', entryPoint: 'https://adfs.test/sso2', entityId: 'thunderbolt-sp' },
          })

          expect(response.status).toBe(200)
          expect(await response.text()).not.toContain('second-cert')
          expect(await storedConfig('adfs')).toEqual({
            ...before,
            cert: 'second-cert',
            entryPoint: 'https://adfs.test/sso2',
          })
          const [updated] = await events('connection.updated')
          expect((updated.metadata as { changedFields: string[] }).changedFields.sort()).toEqual([
            'samlConfig.cert',
            'samlConfig.entryPoint',
          ])
        })

        it.each([
          ['providerId', oidcBody('okta'), { providerId: 'okta-2' }],
          ['issuer', oidcBody('okta'), { oidc: { issuer: 'https://elsewhere.test' } }],
          ['entityId', samlBody('adfs'), { saml: { entityId: 'another-sp' } }],
          ['idpIssuer', samlBody('adfs'), { saml: { idpIssuer: 'https://elsewhere.test' } }],
        ])('refuses to change the %s, and records it', async (field, createBody, body) => {
          const connectionId = await create(createBody)

          const response = await edit(connectionId, body)

          expect(response.status).toBe(409)
          expect(await response.json()).toMatchObject({ code: 'SSO_IDENTITY_FIELD_IMMUTABLE', field })
          expect(await events('connection.updated', 'denied')).toMatchObject([
            { actorId: adminId, targetId: connectionId, reason: 'SSO_IDENTITY_FIELD_IMMUTABLE' },
          ])
          expect(await events('connection.updated')).toHaveLength(0)
        })

        it.each([
          ['clientId', oidcBody('okta'), { oidc: { clientId: 'another-client' } }],
          ['discoveryEndpoint', oidcBody('okta'), { oidc: { discoveryEndpoint: 'https://okta.test/other' } }],
          ['entryPoint', samlBody('adfs'), { saml: { entryPoint: 'https://adfs.test/other' } }],
        ])('refuses to change the %s once an identity is linked, and records it', async (field, createBody, body) => {
          const connectionId = await create(createBody)
          const { sso } = await json<{ sso: { providerId: string } }>(
            await call('GET', `/v1/admin/connections/${connectionId}`),
          )
          await linkAccount(sso.providerId)

          const response = await edit(connectionId, body)

          expect(response.status).toBe(409)
          expect(await response.json()).toMatchObject({ code: 'SSO_IDENTITY_FIELD_LOCKED', field })
          expect(await events('connection.updated', 'denied')).toMatchObject([{ reason: 'SSO_IDENTITY_FIELD_LOCKED' }])
          // A secret or certificate still rotates.
          const rotation = 'oidc' in body ? { oidc: { clientSecret: 'new' } } : { saml: { cert: 'new' } }
          expect((await edit(connectionId, rotation)).status).toBe(200)
        })

        it('changes the client id of a connection nothing is linked through yet', async () => {
          const connectionId = await create(oidcBody('okta'))

          expect((await edit(connectionId, { oidc: { clientId: 'another-client' } })).status).toBe(200)
          expect(await storedConfig('okta')).toMatchObject({ clientId: 'another-client' })
        })

        it('changes the match claim only while nothing is linked or awaiting review', async () => {
          const connectionId = await create(oidcBody('entra'))
          expect(await json(await edit(connectionId, { matchClaim: 'oid' }))).toMatchObject({ matchClaim: 'oid' })
          expect(await events('connection.updated')).toMatchObject([{ metadata: { changedFields: ['matchClaim'] } }])

          await harness.db.insert(linkReview).values({
            id: crypto.randomUUID(),
            orgId,
            identityConnectionId: connectionId,
            trigger: 'sso_sign_in',
            externalId: 'oid-1',
            incomingEmail: 'someone@example.com',
            candidateUserId: adminId,
            lastSeenAt: new Date(),
          })
          const reviewed = await edit(connectionId, { matchClaim: 'sub' })
          expect(reviewed.status).toBe(409)
          expect(await reviewed.json()).toMatchObject({ code: 'SSO_MATCH_CLAIM_LOCKED' })

          await harness.db.delete(linkReview).where(eq(linkReview.identityConnectionId, connectionId))
          await linkAccount('entra')
          const linked = await edit(connectionId, { matchClaim: 'sub' })
          expect(linked.status).toBe(409)
          expect(await linked.json()).toMatchObject({ code: 'SSO_MATCH_CLAIM_LOCKED' })
          expect(await events('connection.updated', 'denied')).toHaveLength(2)
        })

        it('refuses the env connection, another protocol, a taken name and an untrusted discovery URL', async () => {
          const [provider] = await harness.db
            .insert(ssoProvider)
            .values({ id: crypto.randomUUID(), providerId: 'sso', issuer: 'https://env.test', domain: '' })
            .returning()
          await harness.db
            .insert(identityConnection)
            .values({ id: envSsoConnectionId, orgId, name: 'Company SSO', ssoProviderId: provider.id })
          const connectionId = await create(oidcBody('okta'))
          const before = await storedConfig('okta')

          const refusals = [
            [await edit(envSsoConnectionId, { name: 'Renamed' }), 409, 'SSO_CONNECTION_ENV_OWNED'],
            [await edit(connectionId, { saml: { cert: 'cert' } }), 400, 'SSO_PROTOCOL_MISMATCH'],
            [await edit(connectionId, { name: 'company sso' }), 409, 'CONNECTION_NAME_TAKEN'],
            [
              await edit(connectionId, { oidc: { discoveryEndpoint: 'https://untrusted.test/discovery' } }),
              400,
              'SSO_DISCOVERY_URL_UNTRUSTED',
            ],
            [await edit('no-such-connection', { name: 'Renamed' }), 404, 'SSO_CONNECTION_NOT_FOUND'],
          ] as const
          for (const [response, status, code] of refusals) {
            expect(response.status).toBe(status)
            expect(await response.json()).toMatchObject({ code })
          }
          expect(await storedConfig('okta')).toEqual(before)
          expect(await events('connection.updated')).toHaveLength(0)
          // Only the policy refusal is recorded; input errors are not.
          expect((await events('connection.updated', 'denied')).map((event) => event.reason)).toEqual([
            'SSO_CONNECTION_ENV_OWNED',
          ])
        })
      })

      it('creates a SCIM connection and returns its token once, uncached', async () => {
        const created = await call('POST', '/v1/admin/connections/scim', { name: 'Entra' })
        expect(created.status).toBe(200)
        expect(created.headers.get('cache-control')).toBe('no-store')
        const body = await json<{ connection: { id: string }; token: string }>(created)
        expect(body.token).toEqual(expect.any(String))

        const detail = await call('GET', `/v1/admin/connections/${body.connection.id}`)
        expect(await detail.json()).toMatchObject({ scimCredentials: [{ status: 'active' }] })
        expect(JSON.stringify(await json(await call('GET', '/v1/admin/connections')))).not.toContain(body.token)

        const unavailable = await call('POST', '/v1/admin/connections/scim', {
          identityConnectionId: body.connection.id,
        })
        expect(unavailable.status).toBe(409)
        expect(await events('connection.updated', 'denied')).toMatchObject([{ reason: 'SCIM_CONNECTION_UNAVAILABLE' }])
        expect((await call('POST', '/v1/admin/connections/scim', { name: 'entra' })).status).toBe(409)
      })
    })
  })
})
