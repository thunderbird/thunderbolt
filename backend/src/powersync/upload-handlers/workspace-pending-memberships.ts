/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  deletePendingMembership,
  getPendingMembershipById,
  isPersonalWorkspace,
  isWorkspaceAdmin,
  type Role,
  updatePendingMembership,
  upsertPendingMembership,
} from '@/dal/workspaces'
import { allow, reject } from './helpers'
import { UploadRejection, type UploadHandler } from './types'

const isRole = (v: unknown): v is Role => v === 'admin' || v === 'member'

/**
 * Upload handler for `workspace_pending_memberships`. All operations require admin
 * role in the target workspace; personal workspaces cannot have pending memberships.
 * Email is normalized server-side by the DAL to match the Better Auth `before` hook.
 */
export const workspacePendingMembershipsHandler: UploadHandler = {
  validate: async (op, ctx, tx) => {
    if (op.op === 'PUT') {
      const targetWorkspaceId = typeof op.data?.workspace_id === 'string' ? op.data.workspace_id : undefined
      if (!targetWorkspaceId) {
        const existing = await getPendingMembershipById(tx, op.id)
        if (!existing) {
          return reject('permanent', 'WORKSPACE_ID_REQUIRED')
        }
        if (await isPersonalWorkspace(tx, existing.workspaceId)) {
          return reject('permanent', 'PERSONAL_WORKSPACE_IMMUTABLE')
        }
        if (!(await isWorkspaceAdmin(tx, existing.workspaceId, ctx.userId))) {
          return reject('permanent', 'NOT_WORKSPACE_ADMIN')
        }
        return allow()
      }
      if (await isPersonalWorkspace(tx, targetWorkspaceId)) {
        return reject('permanent', 'PERSONAL_WORKSPACE_IMMUTABLE')
      }
      if (!(await isWorkspaceAdmin(tx, targetWorkspaceId, ctx.userId))) {
        return reject('permanent', 'NOT_WORKSPACE_ADMIN')
      }
      return allow()
    }

    const existing = await getPendingMembershipById(tx, op.id)
    if (!existing) {
      return reject('permanent', 'ROW_NOT_FOUND')
    }
    if (await isPersonalWorkspace(tx, existing.workspaceId)) {
      return reject('permanent', 'PERSONAL_WORKSPACE_IMMUTABLE')
    }
    if (!(await isWorkspaceAdmin(tx, existing.workspaceId, ctx.userId))) {
      return reject('permanent', 'NOT_WORKSPACE_ADMIN')
    }
    return allow()
  },

  apply: async (op, ctx, tx) => {
    switch (op.op) {
      case 'PUT': {
        const workspaceId = typeof op.data?.workspace_id === 'string' ? op.data.workspace_id : null
        const email = typeof op.data?.email === 'string' ? op.data.email : null
        const role = isRole(op.data?.role) ? op.data.role : null
        const invitedByUserId =
          typeof op.data?.invited_by_user_id === 'string' ? op.data.invited_by_user_id : ctx.userId
        if (!workspaceId || !email || !role) {
          throw new UploadRejection('permanent', 'PENDING_FIELDS_REQUIRED')
        }
        await upsertPendingMembership(tx, {
          id: op.id,
          workspaceId,
          email,
          role,
          invitedByUserId,
        })
        return
      }
      case 'PATCH': {
        const email = typeof op.data?.email === 'string' ? op.data.email : undefined
        const role = isRole(op.data?.role) ? op.data.role : undefined
        const invitedByUserId = typeof op.data?.invited_by_user_id === 'string' ? op.data.invited_by_user_id : undefined

        if (email === undefined && role === undefined && invitedByUserId === undefined) {
          throw new UploadRejection('permanent', 'EMPTY_PAYLOAD')
        }
        const affected = await updatePendingMembership(tx, op.id, { email, role, invitedByUserId })
        if (affected === 0) {
          throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
        }
        return
      }
      case 'DELETE': {
        const affected = await deletePendingMembership(tx, op.id)
        if (affected === 0) {
          throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
        }
        return
      }
    }
  },
}
