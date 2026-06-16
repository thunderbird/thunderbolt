/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  deleteWorkspacePermission,
  getWorkspacePermissionById,
  isPersonalWorkspace,
  isWorkspaceAdmin,
  type Role,
  updateWorkspacePermission,
  upsertWorkspacePermission,
} from '@/dal/workspaces'
import { isWorkspacePermissionKey } from '@shared/workspaces'
import { allow, reject } from './helpers'
import { UploadRejection, type UploadHandler } from './types'

const isRole = (v: unknown): v is Role => v === 'admin' || v === 'member'

/**
 * Upload handler for `workspace_permissions`. All operations require admin role
 * in the target workspace; personal workspaces have no configurable permissions
 * in v1 (Decision 11).
 */
export const workspacePermissionsHandler: UploadHandler = {
  validate: async (op, ctx, tx) => {
    if (op.op === 'PUT') {
      const targetWorkspaceId = typeof op.data?.workspace_id === 'string' ? op.data.workspace_id : undefined
      if (!targetWorkspaceId) {
        const existing = await getWorkspacePermissionById(tx, op.id)
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

    const existing = await getWorkspacePermissionById(tx, op.id)
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
        const permissionKey = isWorkspacePermissionKey(op.data?.permission_key) ? op.data.permission_key : null
        const requiredRole = isRole(op.data?.required_role) ? op.data.required_role : null
        if (!workspaceId || !permissionKey || !requiredRole) {
          throw new UploadRejection('permanent', 'PERMISSION_FIELDS_REQUIRED')
        }
        await upsertWorkspacePermission(tx, {
          id: op.id,
          workspaceId,
          permissionKey,
          requiredRole,
        })
        return
      }
      case 'PATCH': {
        const requiredRole = isRole(op.data?.required_role) ? op.data.required_role : undefined
        if (requiredRole === undefined) {
          throw new UploadRejection('permanent', 'EMPTY_PAYLOAD')
        }
        const affected = await updateWorkspacePermission(tx, op.id, { requiredRole })
        if (affected === 0) {
          throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
        }
        return
      }
      case 'DELETE': {
        const affected = await deleteWorkspacePermission(tx, op.id)
        if (affected === 0) {
          throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
        }
        return
      }
    }
  },
}
