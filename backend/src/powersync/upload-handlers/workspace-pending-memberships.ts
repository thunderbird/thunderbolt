/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  deletePendingMembership,
  deletePendingMembershipByWorkspaceAndEmail,
  getPendingMembershipById,
  insertMembershipIfMissing,
  isPersonalWorkspace,
  type Role,
  updatePendingMembership,
  upsertPendingMembership,
} from '@/dal/workspaces'
import { getUserByEmail } from '@/dal/users'
import { isValidEmailFormat, normalizeEmail } from '@/lib/email'
import { allow, callerSatisfiesPermission, reject } from './helpers'
import { UploadRejection, type UploadHandler } from './types'

const isRole = (v: unknown): v is Role => v === 'admin' || v === 'member'

/**
 * Upload handler for `workspace_pending_memberships`. Every write gates on the
 * `invite_users` permission (admin by default, Decision 11). Promoting/editing
 * a pending invite to `role: 'admin'` additionally requires `change_roles` —
 * see the inline guard. Personal workspaces cannot have pending memberships.
 * Email is normalized server-side by the DAL to match the Better Auth `before` hook.
 */
export const workspacePendingMembershipsHandler: UploadHandler = {
  validate: async (op, ctx, tx) => {
    // @todo Revisit when the E2EE pipeline supports multi-recipient envelopes
    // and is workspace-aware. Pending memberships are by definition for someone
    // else, so any insert on an E2EE-enabled server would produce data the
    // invitee can't decrypt. See THU-593.
    if (op.op === 'PUT' && ctx.settings.e2eeEnabled) {
      return reject('permanent', 'E2EE_MEMBERSHIPS_DISABLED')
    }

    // All pending-membership writes (create / edit / cancel an invite) gate on
    // `invite_users` so a workspace that grants `member` the permission can
    // exercise it on upload. Defaults to admin via Decision 11.
    //
    // Inviting (or editing the invite to) `role: 'admin'` additionally requires
    // `change_roles` — otherwise `invite_users` alone could mint new admins
    // via the signup-promote path, bypassing the gate that protects existing
    // members from being promoted by non-role-managers.
    const targetsAdminRole = op.data?.role === 'admin'
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
        if (!(await callerSatisfiesPermission(tx, existing.workspaceId, ctx.userId, 'invite_users'))) {
          return reject('permanent', 'INSUFFICIENT_PERMISSION')
        }
        if (
          targetsAdminRole &&
          !(await callerSatisfiesPermission(tx, existing.workspaceId, ctx.userId, 'change_roles'))
        ) {
          return reject('permanent', 'INSUFFICIENT_PERMISSION')
        }
        return allow()
      }
      if (await isPersonalWorkspace(tx, targetWorkspaceId)) {
        return reject('permanent', 'PERSONAL_WORKSPACE_IMMUTABLE')
      }
      if (!(await callerSatisfiesPermission(tx, targetWorkspaceId, ctx.userId, 'invite_users'))) {
        return reject('permanent', 'INSUFFICIENT_PERMISSION')
      }
      if (targetsAdminRole && !(await callerSatisfiesPermission(tx, targetWorkspaceId, ctx.userId, 'change_roles'))) {
        return reject('permanent', 'INSUFFICIENT_PERMISSION')
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
    if (!(await callerSatisfiesPermission(tx, existing.workspaceId, ctx.userId, 'invite_users'))) {
      return reject('permanent', 'INSUFFICIENT_PERMISSION')
    }
    // Guard fires only on promotions (role becoming admin). Demoting an
    // existing pending admin invite to `member` stays gated on `invite_users`
    // alone — it's tampering, not escalation, and matching the broader
    // "any role change requires change_roles" rule from the memberships
    // handler would cost an extra DB read (load existing pending row) for
    // a non-security concern.
    if (
      op.op === 'PATCH' &&
      targetsAdminRole &&
      !(await callerSatisfiesPermission(tx, existing.workspaceId, ctx.userId, 'change_roles'))
    ) {
      return reject('permanent', 'INSUFFICIENT_PERMISSION')
    }
    return allow()
  },

  apply: async (op, ctx, tx) => {
    switch (op.op) {
      case 'PUT': {
        const workspaceId = typeof op.data?.workspace_id === 'string' ? op.data.workspace_id : null
        const email = typeof op.data?.email === 'string' ? op.data.email : null
        const role = isRole(op.data?.role) ? op.data.role : null
        if (!workspaceId || !email || !role) {
          throw new UploadRejection('permanent', 'PENDING_FIELDS_REQUIRED')
        }
        if (!isValidEmailFormat(email)) {
          throw new UploadRejection('permanent', 'INVALID_EMAIL')
        }
        // `invitedByUserId` is server-truth — the caller is the inviter, full
        // stop. Trusting the payload would let a client attribute the invite
        // to someone else.
        await upsertPendingMembership(tx, {
          id: op.id,
          workspaceId,
          email,
          role,
          invitedByUserId: ctx.userId,
        })

        // Promote-on-insert: if the invited email already belongs to a real
        // user on this server, write a membership row + delete the pending
        // row in the same transaction. PostgreSQL emits both ops in WAL order
        // so PowerSync ships the insert+delete back to the originating FE,
        // which removes its optimistic local pending row organically. The
        // signup hook (`promotePendingMemberships`) covers the unknown-email
        // path when the invitee later signs up.
        //
        // DO-NOTHING semantics: if the user is already a member of this
        // workspace, the invite must NOT overwrite their current role —
        // inviting an existing admin's email would otherwise downgrade them
        // to whatever role the invite carried. Mirrors
        // `promotePendingMemberships` (the signup-time bulk-promote path).
        const matched = await getUserByEmail(tx, normalizeEmail(email))
        if (matched) {
          await insertMembershipIfMissing(tx, {
            id: crypto.randomUUID(),
            workspaceId,
            userId: matched.id,
            role,
            userName: matched.name,
            userEmail: matched.email,
          })
          // Delete by `(workspace_id, email)` rather than `op.id` — the upsert
          // above hit the `(workspace_id, email)` unique constraint when the
          // pending row already existed, in which case Postgres kept the
          // original id and the upload's `op.id` no longer matches. Keying on
          // workspace+email always lands on the actual row.
          await deletePendingMembershipByWorkspaceAndEmail(tx, workspaceId, email)
        }
        return
      }
      case 'PATCH': {
        // `invited_by_user_id` is server-truth and not patchable by the
        // client — silently drop it from the payload rather than rewriting
        // it to an attacker-supplied value.
        const email = typeof op.data?.email === 'string' ? op.data.email : undefined
        const role = isRole(op.data?.role) ? op.data.role : undefined

        if (email === undefined && role === undefined) {
          throw new UploadRejection('permanent', 'EMPTY_PAYLOAD')
        }
        if (email !== undefined && !isValidEmailFormat(email)) {
          throw new UploadRejection('permanent', 'INVALID_EMAIL')
        }
        const affected = await updatePendingMembership(tx, op.id, { email, role })
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
