/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createAuth } from '@/auth/auth'
import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { auditEvent } from '@/db/schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { insertTestUsers } from '@/test-utils/identity'
import { createScimClient, keycloakUser, type ScimClient, scimGroupSchema, uniqueSuffix } from '@/test-utils/scim'
import {
  type AuthEndpointContext,
  getCurrentAdapter,
  runWithEndpointContext,
  runWithTransaction,
} from '@better-auth/core/context'
import { beforeAll, describe, expect, it } from 'bun:test'
import type { DBAdapter } from 'better-auth'
import { and, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { getCurrentOrganizationId } from '../current-organization'
import { createScimConnection } from './connections'
import { scimProjection } from './projection'
import { withScimRequestScope } from './request-scope'

describe('SCIM resource audit events', () => {
  let db: IsolatedTestDb['db']
  let auth: Auth
  let handle: (request: Request) => Promise<Response>
  let actorId: string

  beforeAll(async () => {
    ;({ db } = await getSharedIsolatedTestDb())
    auth = createAuth(db)
    const app = new Elysia({ prefix: '/v1' }).use(createBetterAuthPlugin(db).plugin)
    handle = (request) => app.handle(request)
    actorId = `scim-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
  })

  const setUp = async () => {
    const { connection, credential, token } = await createScimConnection(auth, {
      actorId,
      name: `IdP ${uniqueSuffix()}`,
    })
    const scim = createScimClient(handle, token)
    const email = `member-${uniqueSuffix()}@example.com`
    const user = await scim.call('POST', '/Users', { body: keycloakUser(email, email, crypto.randomUUID()) })
    expect(user.status).toBe(201)
    return {
      connectionId: connection.id,
      scimConnectionId: connection.scimConnectionId!,
      credentialId: credential.credentialId,
      scim,
      scimUserId: user.body.id!,
    }
  }

  /** The SCIM resource events a connection has, as `action target` strings. */
  const eventsOf = async (connectionId: string, credentialId: string) => {
    const rows = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.connectionId, connectionId), eq(auditEvent.actorType, 'scim_connection')))
    for (const row of rows.filter((candidate) => candidate.action.startsWith('scim.'))) {
      expect(row).toMatchObject({ actorId: connectionId, credentialId, outcome: 'success' })
    }
    return rows
      .filter((row) => row.action.startsWith('scim.'))
      .map((row) => `${row.action} ${row.targetType}:${row.targetId}`)
  }

  const createGroup = async (scim: ScimClient, members: string[]) => {
    const created = await scim.call('POST', '/Groups', {
      body: {
        schemas: [scimGroupSchema],
        displayName: `Group ${uniqueSuffix()}`,
        members: members.map((value) => ({ value })),
      },
    })
    expect(created.status).toBe(201)
    return created.body.id!
  }

  it.each([
    { members: true, label: 'with members, in the transaction' },
    { members: false, label: 'without members, after the commit' },
  ])('records each user and group change once: $label', async ({ members }) => {
    const { connectionId, credentialId, scim, scimUserId } = await setUp()
    const [user] = (await eventsOf(connectionId, credentialId)).filter((event) => event.startsWith('scim.user_created'))
    const userTarget = user.split(' ')[1]

    expect(
      (await scim.patch(`/Users/${scimUserId}`, [{ op: 'replace', path: 'displayName', value: 'Renamed' }])).status,
    ).toBe(200)
    const groupId = await createGroup(scim, members ? [scimUserId] : [])
    const renamed = await scim.patch(`/Groups/${groupId}`, [
      { op: 'replace', path: 'displayName', value: `Renamed ${uniqueSuffix()}` },
    ])
    expect(renamed.status).toBeLessThan(300)
    if (members) {
      const added = await scim.patch(`/Groups/${groupId}`, [
        { op: 'remove', path: `members[value eq "${scimUserId}"]` },
      ])
      expect(added.status).toBeLessThan(300)
    }
    expect((await scim.call('DELETE', `/Groups/${groupId}`)).status).toBe(204)
    // A replay re-runs every callback and must write nothing.
    await auth.api.reconcileSCIMProjection({ body: { provisioningDomainId: getCurrentOrganizationId() } })

    const group = `scim_group:${groupId}`
    expect((await eventsOf(connectionId, credentialId)).sort()).toEqual(
      [
        `scim.user_created ${userTarget}`,
        `scim.user_updated ${userTarget}`,
        `scim.group_created ${group}`,
        `scim.group_updated ${group}`,
        ...(members ? [`scim.group_members_changed ${group}`] : []),
        `scim.group_deleted ${group}`,
      ].sort(),
    )
  })

  it('leaves the sessions the plugin signs out on active:false to the session hooks', async () => {
    const { connectionId, scim, scimUserId } = await setUp()

    await scim.patch(`/Users/${scimUserId}`, [{ op: 'replace', path: 'active', value: false }])

    const revoked = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'auth.session_revoked'), eq(auditEvent.connectionId, connectionId)))
    expect(revoked).toHaveLength(0)
  })

  it('records a group change once when the attempt that first wrote it rolled back and was retried', async () => {
    const { connectionId, scimConnectionId, credentialId } = await setUp()
    const groupId = `group-${uniqueSuffix()}`
    const context = await auth.$context
    // The endpoint context the plugin's auth middleware leaves for a group PATCH.
    const endpoint = {
      path: '/scim/v2/Groups/:groupId',
      method: 'PATCH',
      params: { groupId },
      body: { Operations: [{ op: 'replace', path: 'displayName', value: 'Renamed' }] },
      context: {
        ...context,
        scimPrincipal: {
          type: 'managed-bearer',
          connectionId: scimConnectionId,
          credentialId,
          provisioningDomainId: getCurrentOrganizationId(),
          scopes: [],
        },
      },
    } as unknown as AuthEndpointContext
    const adapter = context.adapter as unknown as DBAdapter
    const state = {
      provisioningDomainId: getCurrentOrganizationId(),
      userId: 'u',
      active: true,
      sources: [],
      grants: [],
    }
    // One attempt, calling the projection for two members as the plugin does.
    const attempt = (rollBack: boolean) =>
      runWithTransaction(adapter, async () => {
        for (let member = 0; member < 2; member++) {
          await scimProjection.reconcileUser(state, { database: await getCurrentAdapter(adapter) })
        }
        if (rollBack) {
          throw new Error('changed concurrently')
        }
      })

    const { scope } = await withScimRequestScope(() =>
      runWithEndpointContext(endpoint, async () => {
        await expect(attempt(true)).rejects.toThrow('changed concurrently')
        await attempt(false)
      }),
    )

    expect(scope.groupEventsRecorded).toBe(true)
    expect(await eventsOf(connectionId, credentialId)).toContain(`scim.group_updated scim_group:${groupId}`)
    expect(
      (await eventsOf(connectionId, credentialId)).filter((event) => event.startsWith('scim.group_updated')),
    ).toHaveLength(1)
  })
})
