/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  auditEvent,
  groupRoleMapping,
  identityConnection,
  invitation,
  localGroup,
  memberRoleGrant,
  membershipSource,
  orgDomain,
  orgMembership,
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
  const addIdpManagedMember = async () => {
    const [connection] = await harness.db
      .insert(identityConnection)
      .values({
        id: crypto.randomUUID(),
        orgId,
        name: `Entra ${crypto.randomUUID()}`,
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

      it('flags break-glass when every admin is IdP-managed', async () => {
        expect(await json(await call('GET', '/v1/admin/break-glass'))).toEqual({
          allAdminsIdpManaged: false,
          adminCount: 1,
          localAdminCount: 1,
        })

        const { userId: managed } = await addIdpManagedMember()
        await grantAdmin(managed)
        await harness.db
          .delete(memberRoleGrant)
          .where(eq(memberRoleGrant.membershipId, (await membershipOf(adminId)).id))
        // The harness user is no longer an admin, so read the flag the way the route does.
        expect(await getBreakGlassStatus(harness.db)).toEqual({
          allAdminsIdpManaged: true,
          adminCount: 1,
          localAdminCount: 0,
        })
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
