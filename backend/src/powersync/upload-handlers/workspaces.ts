/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  getWorkspaceById,
  isAdminOfAnyWorkspace,
  isWorkspaceAdmin,
  updateSharedWorkspace,
  upsertSharedWorkspace,
} from '@/dal/workspaces'
import { allow, reject } from './helpers'
import { UploadRejection, type UploadHandler } from './types'

/**
 * Upload handler for the `workspaces` table. Enforces:
 *
 * - Personal workspace rows are backend-only (Better Auth post-create hook owns them).
 *   Both creating one from the client and renaming an existing personal workspace
 *   are permanent rejects.
 * - Shared workspace creation is gated by `allowWorkspaceCreationByMembers`. Members
 *   may create only when the flag is on; users who already admin some workspace can
 *   always create new ones regardless of the flag.
 * - Updates require the caller to be an admin of the target workspace.
 * - Deletes are out of scope for v1 — permanently rejected.
 */
export const workspacesHandler: UploadHandler = {
  validate: async (op, ctx, tx) => {
    if (op.op === 'DELETE') {
      return reject('permanent', 'WORKSPACE_DELETE_DISABLED')
    }

    const existing = await getWorkspaceById(tx, op.id)

    if (op.op === 'PATCH') {
      if (!existing) {
        return reject('permanent', 'ROW_NOT_FOUND')
      }
      if (existing.isPersonal) {
        return reject('permanent', 'PERSONAL_WORKSPACE_IMMUTABLE')
      }
      if (!(await isWorkspaceAdmin(tx, op.id, ctx.userId))) {
        return reject('permanent', 'NOT_WORKSPACE_ADMIN')
      }
      return allow()
    }

    // PUT — either insert (existing == null) or update (existing != null).
    if (existing) {
      if (existing.isPersonal) {
        return reject('permanent', 'PERSONAL_WORKSPACE_IMMUTABLE')
      }
      if (!(await isWorkspaceAdmin(tx, op.id, ctx.userId))) {
        return reject('permanent', 'NOT_WORKSPACE_ADMIN')
      }
      return allow()
    }

    const payloadIsPersonal = op.data?.is_personal === true
    if (payloadIsPersonal) {
      return reject('permanent', 'PERSONAL_WORKSPACE_SERVER_MANAGED')
    }

    const memberMayCreate =
      ctx.settings.allowWorkspaceCreationByMembers || (await isAdminOfAnyWorkspace(tx, ctx.userId))
    if (!memberMayCreate) {
      return reject('permanent', 'WORKSPACE_CREATION_DISABLED')
    }

    return allow()
  },

  apply: async (op, _ctx, tx) => {
    switch (op.op) {
      case 'PUT': {
        const name = typeof op.data?.name === 'string' ? op.data.name : null
        if (!name) {
          throw new UploadRejection('permanent', 'WORKSPACE_NAME_REQUIRED')
        }
        await upsertSharedWorkspace(tx, { id: op.id, name })
        return
      }
      case 'PATCH': {
        const name = typeof op.data?.name === 'string' ? op.data.name : undefined
        if (name === undefined) {
          throw new UploadRejection('permanent', 'EMPTY_PAYLOAD')
        }
        const affected = await updateSharedWorkspace(tx, op.id, { name })
        if (affected === 0) {
          throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
        }
        return
      }
      case 'DELETE': {
        // Guarded by validate; reachable only if validate is bypassed.
        throw new UploadRejection('permanent', 'WORKSPACE_DELETE_DISABLED')
      }
    }
  },
}
