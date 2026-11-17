/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createAuth } from '@/auth/auth'
import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { auditEvent, groupRoleMapping, identityConnection, orgMembership, scimProjectionGrant, user } from '@/db/schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { insertTestUsers } from '@/test-utils/identity'
import { createScimClient, keycloakUser, type ScimClient, scimGroupSchema, uniqueSuffix } from '@/test-utils/scim'
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { listAdmins } from '../admin/members'
import { getMemberAuthorization, loadRoleSources } from '../roles'
import { createScimConnection } from './connections'
import { createScimGroupRoleMapping, deleteScimGroupRoleMapping } from './role-mappings'

describe('SCIM group role mappings', () => {
  let db: IsolatedTestDb['db']
  let auth: Auth
  let app: { handle: (request: Request) => Promise<Response> }
  let actorId: string

  beforeAll(async () => {
    ;({ db } = await getSharedIsolatedTestDb())
    auth = createAuth(db)
    app = new Elysia({ prefix: '/v1' }).use(createBetterAuthPlugin(db).plugin)
    actorId = `scim-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
  })

  /** A connection with one provisioned member. */
  const setUp = async () => {
    const { connection, token } = await createScimConnection(auth, { actorId, name: `IdP ${uniqueSuffix()}` })
    const scim = createScimClient((request) => app.handle(request), token)
    const email = `member-${uniqueSuffix()}@example.com`
    const created = await scim.call('POST', '/Users', { body: keycloakUser(email, email, crypto.randomUUID()) })
    expect(created.status).toBe(201)
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
    return { connection, scim, scimUserId: created.body.id!, userId: row.id }
  }

  const createGroup = async (scim: ScimClient, displayName: string, members: string[]) => {
    const created = await scim.call('POST', '/Groups', {
      body: { schemas: [scimGroupSchema], displayName, members: members.map((value) => ({ value })) },
    })
    expect(created.status).toBe(201)
    return created.body.id!
  }

  const rolesOf = async (userId: string) =>
    [...(await getMemberAuthorization({ adapter: (await auth.$context).adapter, database: db }, userId)).roles].sort()

  it('grants a mapped group role to its members at once, and takes it away when the mapping goes', async () => {
    const { connection, scim, scimUserId, userId } = await setUp()
    const groupId = await createGroup(scim, `Finance ${uniqueSuffix()}`, [scimUserId])
    expect(await rolesOf(userId)).toEqual(['member'])

    const mappingId = await createScimGroupRoleMapping(auth, db, {
      identityConnectionId: connection.id,
      scimGroupId: groupId,
      role: 'admin',
      actorId,
    })

    expect(await rolesOf(userId)).toEqual(['admin', 'member'])

    await deleteScimGroupRoleMapping(auth, db, { mappingId, actorId })

    expect(await rolesOf(userId)).toEqual(['member'])
    const actions = (await db.select().from(auditEvent).where(eq(auditEvent.targetId, mappingId))).map((e) => e.action)
    expect(actions.sort()).toEqual(['group_role_mapping.created', 'group_role_mapping.deleted'])
  })

  it('follows group membership and the member being deactivated', async () => {
    const { connection, scim, scimUserId, userId } = await setUp()
    const groupId = await createGroup(scim, `Ops ${uniqueSuffix()}`, [])
    await createScimGroupRoleMapping(auth, db, {
      identityConnectionId: connection.id,
      scimGroupId: groupId,
      role: 'admin',
      actorId,
    })

    const members = (op: 'add' | 'remove') =>
      scim.patch(`/Groups/${groupId}`, [{ op, path: 'members', value: [{ value: scimUserId }] }])
    const active = (value: boolean) => scim.patch(`/Users/${scimUserId}`, [{ op: 'replace', path: 'active', value }])

    expect((await members('add')).status).toBeLessThan(300)
    expect(await rolesOf(userId)).toEqual(['admin', 'member'])

    expect((await active(false)).status).toBe(200)
    expect(await db.$count(scimProjectionGrant, eq(scimProjectionGrant.userId, userId))).toBe(0)
    expect((await active(true)).status).toBe(200)
    expect(await rolesOf(userId)).toEqual(['admin', 'member'])

    expect((await members('remove')).status).toBeLessThan(300)
    expect(await rolesOf(userId)).toEqual(['member'])
  })

  it('keys on the group id: a rename grants nothing new and keeps what is mapped', async () => {
    const { connection, scim, scimUserId, userId } = await setUp()
    const mapped = await createGroup(scim, `Finance ${uniqueSuffix()}`, [scimUserId])
    const unmapped = await createGroup(scim, `Staff ${uniqueSuffix()}`, [scimUserId])
    await createScimGroupRoleMapping(auth, db, {
      identityConnectionId: connection.id,
      scimGroupId: mapped,
      role: 'finance-reader',
      actorId,
    })
    const rename = (groupId: string, displayName: string) =>
      scim.patch(`/Groups/${groupId}`, [{ op: 'replace', path: 'displayName', value: displayName }])

    expect((await rename(unmapped, `Admins ${uniqueSuffix()}`)).status).toBeLessThan(300)
    expect((await rename(mapped, `Finance renamed ${uniqueSuffix()}`)).status).toBeLessThan(300)

    expect(await rolesOf(userId)).toEqual(['finance-reader', 'member'])
  })

  /** A provisioned member of a group mapped to `admin`. */
  const setUpAdmin = async () => {
    const setup = await setUp()
    const groupId = await createGroup(setup.scim, `Admins ${uniqueSuffix()}`, [setup.scimUserId])
    const mappingId = await createScimGroupRoleMapping(auth, db, {
      identityConnectionId: setup.connection.id,
      scimGroupId: groupId,
      role: 'admin',
      actorId,
    })
    expect(await rolesOf(setup.userId)).toEqual(['admin', 'member'])
    return { ...setup, mappingId }
  }

  const isListedAdmin = async (userId: string) => (await listAdmins(db)).some((admin) => admin.userId === userId)

  it('grants nothing from a stored grant whose mapping is gone, even before a replay removes it', async () => {
    const { mappingId, userId } = await setUpAdmin()

    // A delete whose replay never ran: the plugin's grant row is still there.
    await db.delete(groupRoleMapping).where(eq(groupRoleMapping.id, mappingId))

    expect(await db.$count(scimProjectionGrant, eq(scimProjectionGrant.userId, userId))).toBe(1)
    expect(await rolesOf(userId)).toEqual(['member'])
    expect(await isListedAdmin(userId)).toBe(false)
  })

  it('grants nothing from a connection whose SCIM side is retiring', async () => {
    const { connection, userId } = await setUpAdmin()
    const [membership] = await db.select().from(orgMembership).where(eq(orgMembership.userId, userId))

    await db.update(identityConnection).set({ status: 'scim_retiring' }).where(eq(identityConnection.id, connection.id))

    expect((await loadRoleSources(db, membership)).scimRoles).toEqual([])
  })

  it("refuses a group that is not the connection's own, and an invalid role", async () => {
    const first = await setUp()
    const second = await setUp()
    const foreignGroup = await createGroup(second.scim, `Foreign ${uniqueSuffix()}`, [])

    await expect(
      createScimGroupRoleMapping(auth, db, {
        identityConnectionId: first.connection.id,
        scimGroupId: foreignGroup,
        role: 'admin',
        actorId,
      }),
    ).rejects.toMatchObject({ body: { code: 'SCIM_GROUP_NOT_FOUND' } })
    await expect(
      createScimGroupRoleMapping(auth, db, {
        identityConnectionId: second.connection.id,
        scimGroupId: foreignGroup,
        role: 'Not A Role',
        actorId,
      }),
    ).rejects.toMatchObject({ body: { code: 'ROLE_INVALID' } })
  })
})
