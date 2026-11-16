/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import type { db as DbType } from '@/db/client'
import { t } from 'elysia'
import { createAdminRoutes } from '../admin-macro'
import { purgeMember } from '../purge'
import {
  blockMember,
  breakGlassWarning,
  detachMemberLink,
  getBreakGlassStatus,
  getMember,
  grantMemberRole,
  listMembers,
  revokeMemberRole,
  unblockMember,
  updateMemberProfile,
} from './members'
import { defaultAdminPageSize, pageQuery } from './pagination'
import { assignableRoleSchema, auditRefusals, cursorParts } from './route-helpers'

const userParams = t.Object({ userId: t.String({ maxLength: 255 }) })

/** Members: who they are, where they came from, what the IdP manages; block, roles, profile, IdP links and purge. */
export const createMemberAdminRoutes = (auth: Auth, database: typeof DbType) =>
  createAdminRoutes('member-admin-routes', auth, database)
    .get(
      '/admin/members',
      async ({ query }) => {
        const [after] = cursorParts(query.cursor, 1) ?? []
        return listMembers(database, { q: query.q, after, limit: query.limit ?? defaultAdminPageSize })
      },
      { query: t.Object({ ...pageQuery, q: t.Optional(t.String({ minLength: 1, maxLength: 200 })) }) },
    )
    .get('/admin/members/:userId', ({ params }) => getMember(database, params.userId), {
      params: userParams,
    })
    .patch(
      '/admin/members/:userId',
      async ({ params, body, user }) => {
        await auditRefusals(
          database,
          { action: 'member.updated', actorId: user.id, target: { type: 'user', id: params.userId } },
          () => updateMemberProfile(database, { userId: params.userId, name: body.name, actorId: user.id }),
        )
        return getMember(database, params.userId)
      },
      { params: userParams, body: t.Object({ name: t.String({ minLength: 1, maxLength: 200 }) }) },
    )
    .post(
      '/admin/members/:userId/block',
      async ({ params, body, user }) => {
        await auditRefusals(
          database,
          { action: 'member.blocked', actorId: user.id, target: { type: 'user', id: params.userId } },
          () => blockMember(database, { userId: params.userId, actorId: user.id, reason: body?.reason }),
        )
        return { ...(await getMember(database, params.userId)), ...(await breakGlassWarning(database)) }
      },
      {
        params: userParams,
        body: t.Optional(t.Object({ reason: t.Optional(t.String({ maxLength: 500 })) })),
      },
    )
    .post(
      '/admin/members/:userId/unblock',
      async ({ params, user }) => {
        await unblockMember(database, { userId: params.userId, actorId: user.id })
        return getMember(database, params.userId)
      },
      { params: userParams },
    )
    .post(
      '/admin/members/:userId/roles',
      async ({ params, body, user }) => {
        await grantMemberRole(database, { userId: params.userId, role: body.role, actorId: user.id })
        return getMember(database, params.userId)
      },
      { params: userParams, body: t.Object({ role: assignableRoleSchema }) },
    )
    .delete(
      '/admin/members/:userId/roles/:role',
      async ({ params, user }) => {
        await auditRefusals(
          database,
          { action: 'member.role_revoked', actorId: user.id, target: { type: 'user', id: params.userId } },
          () => revokeMemberRole(database, { userId: params.userId, role: params.role, actorId: user.id }),
        )
        return { ...(await getMember(database, params.userId)), ...(await breakGlassWarning(database)) }
      },
      { params: t.Object({ userId: t.String({ maxLength: 255 }), role: assignableRoleSchema }) },
    )
    .post(
      '/admin/members/:userId/connections/:connectionId/detach',
      async ({ params, user }) => {
        await auditRefusals(
          database,
          { action: 'link.detached', actorId: user.id, target: { type: 'user', id: params.userId } },
          () =>
            detachMemberLink(database, {
              userId: params.userId,
              identityConnectionId: params.connectionId,
              actorId: user.id,
            }),
        )
        return getMember(database, params.userId)
      },
      { params: t.Object({ userId: t.String({ maxLength: 255 }), connectionId: t.String({ maxLength: 255 }) }) },
    )
    .delete(
      '/admin/members/:userId',
      // A purged member has no access, so never holds admin: nothing here can leave the org without one.
      async ({ params, user, set }) => {
        await auditRefusals(
          database,
          { action: 'member.purged', actorId: user.id, target: { type: 'user', id: params.userId } },
          () => purgeMember(auth, { userId: params.userId, actorId: user.id }),
        )
        set.status = 204
      },
      { params: userParams },
    )
    .get('/admin/break-glass', () => getBreakGlassStatus(database))
