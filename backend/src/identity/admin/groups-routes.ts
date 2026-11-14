/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import type { db as DbType } from '@/db/client'
import { t } from 'elysia'
import { createAdminRoutes } from '../admin-macro'
import { createScimGroupRoleMapping, deleteScimGroupRoleMapping } from '../scim/role-mappings'
import {
  addLocalGroupMember,
  createLocalGroup,
  createLocalGroupRoleMapping,
  deleteLocalGroup,
  deleteLocalGroupRoleMapping,
  findRoleMappingKind,
  getLocalGroup,
  listLocalGroupMembers,
  listLocalGroups,
  listRoleMappings,
  listScimGroups,
  removeLocalGroupMember,
  updateLocalGroup,
} from './groups'
import { breakGlassWarning } from './members'
import { defaultAdminPageSize, pageQuery } from './pagination'
import { assignableRoleSchema, cursorParts } from './route-helpers'

const id = t.String({ maxLength: 255 })
const groupParams = t.Object({ groupId: id })
const groupName = t.String({ minLength: 1, maxLength: 100 })
const groupDescription = t.String({ maxLength: 500 })

/**
 * Local groups and their members, and group-to-role mappings for local and SCIM groups. SCIM groups
 * are read-only here: the IdP owns them, and a mapping names one by its id, never its name.
 */
export const createGroupAdminRoutes = (auth: Auth, database: typeof DbType) =>
  createAdminRoutes('group-admin-routes', auth, database)
    .get(
      '/admin/groups',
      ({ query }) =>
        listLocalGroups(database, {
          after: cursorParts(query.cursor, 2) as [string, string] | undefined,
          limit: query.limit ?? defaultAdminPageSize,
        }),
      { query: t.Object(pageQuery) },
    )
    .post(
      '/admin/groups',
      async ({ body, user }) => {
        const group = await createLocalGroup(database, { ...body, actorId: user.id })
        return getLocalGroup(database, group.id)
      },
      { body: t.Object({ name: groupName, description: t.Optional(groupDescription) }) },
    )
    .get('/admin/groups/:groupId', ({ params }) => getLocalGroup(database, params.groupId), {
      params: groupParams,
    })
    .patch(
      '/admin/groups/:groupId',
      async ({ params, body, user }) => {
        await updateLocalGroup(database, { groupId: params.groupId, ...body, actorId: user.id })
        return getLocalGroup(database, params.groupId)
      },
      {
        params: groupParams,
        body: t.Object({ name: t.Optional(groupName), description: t.Optional(groupDescription) }),
      },
    )
    .delete(
      '/admin/groups/:groupId',
      async ({ params, user }) => {
        await deleteLocalGroup(database, { groupId: params.groupId, actorId: user.id })
        return breakGlassWarning(database)
      },
      { params: groupParams },
    )
    .get(
      '/admin/groups/:groupId/members',
      ({ params, query }) => {
        const [after] = cursorParts(query.cursor, 1) ?? []
        return listLocalGroupMembers(database, {
          groupId: params.groupId,
          after,
          limit: query.limit ?? defaultAdminPageSize,
        })
      },
      { params: groupParams, query: t.Object(pageQuery) },
    )
    .post(
      '/admin/groups/:groupId/members',
      async ({ params, body, user, set }) => {
        await addLocalGroupMember(database, { groupId: params.groupId, userId: body.userId, actorId: user.id })
        set.status = 204
      },
      { params: groupParams, body: t.Object({ userId: id }) },
    )
    .delete(
      '/admin/groups/:groupId/members/:userId',
      async ({ params, user }) => {
        await removeLocalGroupMember(database, { groupId: params.groupId, userId: params.userId, actorId: user.id })
        return breakGlassWarning(database)
      },
      { params: t.Object({ groupId: id, userId: id }) },
    )
    .get('/admin/role-mappings', async ({ query }) => ({ items: await listRoleMappings(database, query) }), {
      query: t.Object({ connectionId: t.Optional(id), localGroupId: t.Optional(id) }),
    })
    .post(
      '/admin/role-mappings',
      async ({ body, user }) => {
        const mappingId =
          'localGroupId' in body
            ? await createLocalGroupRoleMapping(database, { ...body, actorId: user.id })
            : await createScimGroupRoleMapping(auth, database, { ...body, actorId: user.id })
        return (await listRoleMappings(database, {})).find((mapping) => mapping.id === mappingId)
      },
      {
        body: t.Union([
          t.Object({ localGroupId: id, role: assignableRoleSchema }, { additionalProperties: false }),
          t.Object(
            { identityConnectionId: id, scimGroupId: id, role: assignableRoleSchema },
            { additionalProperties: false },
          ),
        ]),
      },
    )
    .delete(
      '/admin/role-mappings/:mappingId',
      async ({ params, user }) => {
        const input = { mappingId: params.mappingId, actorId: user.id }
        if ((await findRoleMappingKind(database, params.mappingId)) === 'scim_group') {
          await deleteScimGroupRoleMapping(auth, database, input)
        } else {
          await deleteLocalGroupRoleMapping(database, input)
        }
        return breakGlassWarning(database)
      },
      { params: t.Object({ mappingId: id }) },
    )
    .get(
      '/admin/connections/:connectionId/scim-groups',
      ({ params, query }) =>
        listScimGroups(database, {
          identityConnectionId: params.connectionId,
          after: cursorParts(query.cursor, 2) as [string, string] | undefined,
          limit: query.limit ?? defaultAdminPageSize,
        }),
      { params: t.Object({ connectionId: id }), query: t.Object(pageQuery) },
    )
