/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  getWorkspaceById,
  insertPersonalWorkspaceIfMissing,
  isAdminOfAnyWorkspace,
  isWorkspaceAdmin,
  updateWorkspace,
  upsertWorkspace,
} from '@/dal/workspaces'
import { computePersonalWorkspaceId } from '@shared/workspaces'
import { allow, reject } from './helpers'
import { UploadRejection, type UploadHandler } from './types'

/**
 * Upload handler for the `workspaces` table. Enforces:
 *
 * - **Personal workspace PUT**: allowed iff the row id matches the canonical
 *   `computePersonalWorkspaceId(ctx.userId)` AND `owner_user_id === ctx.userId`.
 *   First-write wins on the name — if the row already exists, the PUT is a
 *   no-op so a second device's idempotent bootstrap doesn't clobber a rename
 *   the user made elsewhere.
 * - **Personal workspace PATCH**: rename allowed, gated on admin of the
 *   workspace (which is always true for the personal owner).
 * - **Shared workspace PUT**: gated by `allowWorkspaceCreationByMembers`.
 *   Members may create only when the flag is on; users who already admin some
 *   workspace can always create regardless of the flag.
 * - **Shared workspace PATCH**: requires the caller to be admin of the target.
 * - **DELETE**: out of scope for v1.
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
      if (!(await isWorkspaceAdmin(tx, op.id, ctx.userId))) {
        return reject('permanent', 'NOT_WORKSPACE_ADMIN')
      }
      return allow()
    }

    // PUT — split by personal vs shared via the payload + id checks.
    const payloadIsPersonal = op.data?.is_personal === true
    const canonicalPersonalId = computePersonalWorkspaceId(ctx.userId)
    const idMatchesCanonical = op.id === canonicalPersonalId

    if (payloadIsPersonal || idMatchesCanonical || existing?.isPersonal) {
      // This is a personal-workspace PUT. Accept only if both the canonical id
      // and the ownership claim match the caller. Anything else — wrong id,
      // someone else's owner_user_id — is rejected.
      if (!idMatchesCanonical) {
        return reject('permanent', 'PERSONAL_WORKSPACE_ID_NOT_CANONICAL')
      }
      const claimedOwner = typeof op.data?.owner_user_id === 'string' ? op.data.owner_user_id : undefined
      if (claimedOwner !== undefined && claimedOwner !== ctx.userId) {
        return reject('permanent', 'PERSONAL_WORKSPACE_OWNER_MISMATCH')
      }
      if (existing && !existing.isPersonal) {
        // The canonical id is already used by a non-personal workspace —
        // structurally impossible if the canonical hashing is correct, but
        // refuse anyway rather than silently mutate a shared workspace.
        return reject('permanent', 'PERSONAL_WORKSPACE_ID_COLLISION')
      }
      return allow()
    }

    // Shared workspace PUT.
    if (existing) {
      // Updating an existing shared workspace via PUT.
      if (!(await isWorkspaceAdmin(tx, op.id, ctx.userId))) {
        return reject('permanent', 'NOT_WORKSPACE_ADMIN')
      }
      return allow()
    }

    const memberMayCreate =
      ctx.settings.allowWorkspaceCreationByMembers || (await isAdminOfAnyWorkspace(tx, ctx.userId))
    if (!memberMayCreate) {
      return reject('permanent', 'WORKSPACE_CREATION_DISABLED')
    }

    return allow()
  },

  apply: async (op, ctx, tx) => {
    switch (op.op) {
      case 'PUT': {
        const canonicalPersonalId = computePersonalWorkspaceId(ctx.userId)
        const isPersonalPut = op.data?.is_personal === true || op.id === canonicalPersonalId
        const incomingName = typeof op.data?.name === 'string' ? op.data.name : null
        // Personal workspaces default to "Default" if the client omitted the name
        // (defensive — current clients always send one). Shared workspaces require it.
        const name = incomingName ?? (isPersonalPut ? 'Default' : null)
        if (!name) {
          throw new UploadRejection('permanent', 'WORKSPACE_NAME_REQUIRED')
        }
        if (isPersonalPut) {
          // `DO NOTHING` on conflict — preserves any later rename if a second
          // device's bootstrap PUT lands after the user already renamed the row.
          await insertPersonalWorkspaceIfMissing(tx, {
            id: op.id,
            name,
            ownerUserId: ctx.userId,
          })
          return
        }
        await upsertWorkspace(tx, {
          id: op.id,
          name,
          isPersonal: false,
          ownerUserId: null,
        })
        return
      }
      case 'PATCH': {
        const name = typeof op.data?.name === 'string' ? op.data.name : undefined
        if (name === undefined) {
          throw new UploadRejection('permanent', 'EMPTY_PAYLOAD')
        }
        const affected = await updateWorkspace(tx, op.id, { name })
        if (affected === 0) {
          throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
        }
        return
      }
      case 'DELETE': {
        throw new UploadRejection('permanent', 'WORKSPACE_DELETE_DISABLED')
      }
    }
  },
}
