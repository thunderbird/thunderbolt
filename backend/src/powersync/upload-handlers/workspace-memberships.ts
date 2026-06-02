/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  countWorkspaceAdmins,
  deleteMembership,
  getMembershipById,
  isPersonalWorkspace,
  isWorkspaceAdmin,
  type Role,
  updateMembership,
  upsertMembership,
} from '@/dal/workspaces'
import { allow, reject } from './helpers'
import { UploadRejection, type UploadHandler } from './types'

const isRole = (v: unknown): v is Role => v === 'admin' || v === 'member'

/**
 * Upload handler for `workspace_memberships`. Enforces:
 *
 * - All writes require admin role in the target workspace.
 * - Personal workspaces are immutable — admin membership exists exactly once and
 *   is created by the Better Auth post-create hook (Decision 11 / Decision 12).
 * - DELETE that would leave zero remaining admins in the workspace is permanently
 *   rejected. The count is taken inside the same transaction as the delete so
 *   concurrent revokes can't both pass the check.
 */
export const workspaceMembershipsHandler: UploadHandler = {
  validate: async (op, ctx, tx) => {
    const targetWorkspaceId =
      op.op === 'PUT' ? (typeof op.data?.workspace_id === 'string' ? op.data.workspace_id : null) : null

    if (op.op === 'PUT' && !targetWorkspaceId) {
      const existing = await getMembershipById(tx, op.id)
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

    if (op.op === 'PUT') {
      // Insert-or-update path: target workspace is whatever the payload carries.
      if (await isPersonalWorkspace(tx, targetWorkspaceId!)) {
        return reject('permanent', 'PERSONAL_WORKSPACE_IMMUTABLE')
      }
      if (!(await isWorkspaceAdmin(tx, targetWorkspaceId!, ctx.userId))) {
        return reject('permanent', 'NOT_WORKSPACE_ADMIN')
      }
      return allow()
    }

    // PATCH / DELETE both target an existing membership row.
    const existing = await getMembershipById(tx, op.id)
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

  apply: async (op, _ctx, tx) => {
    switch (op.op) {
      case 'PUT': {
        const workspaceId = typeof op.data?.workspace_id === 'string' ? op.data.workspace_id : null
        const userId = typeof op.data?.user_id === 'string' ? op.data.user_id : null
        const role = isRole(op.data?.role) ? op.data.role : null
        if (!workspaceId || !userId || !role) {
          throw new UploadRejection('permanent', 'MEMBERSHIP_FIELDS_REQUIRED')
        }
        await upsertMembership(tx, { id: op.id, workspaceId, userId, role })
        return
      }
      case 'PATCH': {
        const role = isRole(op.data?.role) ? op.data.role : undefined
        if (role === undefined) {
          throw new UploadRejection('permanent', 'EMPTY_PAYLOAD')
        }

        // Demoting the last admin would leave the workspace orphaned; capture the
        // existing row inside the tx and reject before applying when applicable.
        const before = await getMembershipById(tx, op.id)
        if (!before) {
          throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
        }
        if (before.role === 'admin' && role !== 'admin') {
          const remainingAdmins = await countWorkspaceAdmins(tx, before.workspaceId, before.id)
          if (remainingAdmins === 0) {
            throw new UploadRejection('permanent', 'LAST_ADMIN_PROTECTED')
          }
        }

        const affected = await updateMembership(tx, op.id, { role })
        if (affected === 0) {
          throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
        }
        return
      }
      case 'DELETE': {
        const before = await getMembershipById(tx, op.id)
        if (!before) {
          throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
        }
        if (before.role === 'admin') {
          const remainingAdmins = await countWorkspaceAdmins(tx, before.workspaceId, before.id)
          if (remainingAdmins === 0) {
            throw new UploadRejection('permanent', 'LAST_ADMIN_PROTECTED')
          }
        }
        const affected = await deleteMembership(tx, op.id)
        if (affected === 0) {
          throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
        }
        return
      }
    }
  },
}
