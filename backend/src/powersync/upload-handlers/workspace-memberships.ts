/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  countWorkspaceAdmins,
  countWorkspaceMemberships,
  deleteMembership,
  getMembershipById,
  getMembershipByWorkspaceAndUser,
  getWorkspaceById,
  isPersonalWorkspace,
  type Role,
  updateMembership,
  upsertMembership,
} from '@/dal/workspaces'
import { getUserById } from '@/dal/users'
import { computePersonalAdminMembershipId, computePersonalWorkspaceId } from '@shared/workspaces'
import { allow, callerSatisfiesPermission, reject } from './helpers'
import { UploadRejection, type UploadHandler, type UploadTx } from './types'

const isRole = (v: unknown): v is Role => v === 'admin' || v === 'member'

/**
 * Personal workspaces are created by the FE (uploaded with a deterministic id);
 * the very first admin membership for that workspace has to land via upload
 * too. The handler's general rule — "must be admin of the target workspace to
 * write a membership" — would reject this initial claim because no admin exists
 * yet. This narrow exception unlocks exactly one shape of row:
 *
 *   - target workspace is personal
 *   - workspace's owner is the caller
 *   - membership id matches the canonical admin-self id for the caller
 *   - membership references the caller as the user
 *   - role is admin
 *
 * Existing-state guard (idempotent re-bootstrap):
 *   - if no memberships exist yet → first claim, allow
 *   - if a single canonical admin row already exists at the same id, pointing
 *     at the same workspace + user + admin role → re-claim is a no-op upsert,
 *     allow. This covers the rollout case where Drizzle 0020 backfilled the
 *     membership server-side and a FE on the new build re-uploads its locally
 *     created row on first sign-in. Rejecting would force PowerSync to revert
 *     the local oplog entry, which causes `WorkspaceGate` to flicker closed.
 *
 * Anything else (different user, different role, extra rows) still falls
 * through to the immutable rejection.
 */
const isPersonalAdminBootstrap = async (
  tx: UploadTx,
  ctx: { userId: string },
  membershipId: string,
  data: Record<string, unknown> | undefined,
): Promise<boolean> => {
  if (membershipId !== computePersonalAdminMembershipId(ctx.userId)) {
    return false
  }
  const targetWorkspaceId = typeof data?.workspace_id === 'string' ? data.workspace_id : null
  if (targetWorkspaceId !== computePersonalWorkspaceId(ctx.userId)) {
    return false
  }
  const targetUserId = typeof data?.user_id === 'string' ? data.user_id : null
  if (targetUserId !== ctx.userId) {
    return false
  }
  if (data?.role !== 'admin') {
    return false
  }
  const workspace = await getWorkspaceById(tx, targetWorkspaceId)
  if (!workspace || !workspace.isPersonal || workspace.ownerUserId !== ctx.userId) {
    return false
  }
  const existingMemberships = await countWorkspaceMemberships(tx, targetWorkspaceId)
  if (existingMemberships === 0) {
    return true
  }
  // Idempotent re-bootstrap path: the only acceptable existing state is the
  // exact canonical admin row we're being asked to upsert. Anything else (a
  // co-member, a non-admin claim at the canonical id) must still reject so a
  // hostile client can't slip past the immutability invariant.
  const existing = await getMembershipById(tx, membershipId)
  return (
    existingMemberships === 1 &&
    existing !== null &&
    existing.workspaceId === targetWorkspaceId &&
    existing.userId === ctx.userId &&
    existing.role === 'admin'
  )
}

/**
 * Upload handler for `workspace_memberships`. Enforces:
 *
 * - Each op gates on a `workspace_permissions` key — `invite_users` for PUT,
 *   `change_roles` for PATCH, `remove_users` for DELETE — defaulting to
 *   admin-only when the permission row is absent (Decision 11).
 * - PUT that would effectively change an existing membership's role
 *   additionally requires `change_roles`. PUT applies via `upsertMembership`
 *   (ON CONFLICT DO UPDATE SET role), so a payload demoting an admin to
 *   member at the same `(workspace_id, user_id)` would otherwise bypass
 *   PATCH's `change_roles` gate.
 * - Adding a brand-new membership with `role: 'admin'` requires
 *   `change_roles` for the same reason — `invite_users` alone could
 *   otherwise mint new admins (also via the pending-invite signup-promote
 *   path).
 * - Personal workspaces are immutable past the FE-driven admin bootstrap
 *   (`isPersonalAdminBootstrap`), which lands exactly one admin row for the
 *   owner the first time the workspace appears server-side.
 * - The first admin membership for a freshly-created shared workspace is
 *   allowed by `isSharedWorkspaceAdminBootstrap` (caller is the row's user,
 *   role is admin, workspace has zero members yet).
 * - DELETE that would leave zero remaining admins is permanently rejected.
 *   The count is taken inside the same transaction so concurrent revokes
 *   can't both pass the check.
 */
/**
 * Shared workspace creator bootstrap: the FE creates a shared workspace and its
 * own admin membership in the same upload batch. When the membership arrives the
 * workspace exists but has zero members, so the general "must be admin" check
 * would reject it. This exception allows exactly one initial claim:
 *
 *   - target workspace exists and is NOT personal
 *   - membership's user_id equals the caller (no impersonation)
 *   - role is admin
 *   - no memberships exist on the workspace yet
 */
const isSharedWorkspaceAdminBootstrap = async (
  tx: UploadTx,
  ctx: { userId: string },
  data: Record<string, unknown> | undefined,
): Promise<boolean> => {
  const targetWorkspaceId = typeof data?.workspace_id === 'string' ? data.workspace_id : null
  if (!targetWorkspaceId) {
    return false
  }
  const targetUserId = typeof data?.user_id === 'string' ? data.user_id : null
  if (targetUserId !== ctx.userId) {
    return false
  }
  if (data?.role !== 'admin') {
    return false
  }
  const workspace = await getWorkspaceById(tx, targetWorkspaceId)
  if (!workspace || workspace.isPersonal) {
    return false
  }
  const existingMemberships = await countWorkspaceMemberships(tx, targetWorkspaceId)
  return existingMemberships === 0
}

export const workspaceMembershipsHandler: UploadHandler = {
  validate: async (op, ctx, tx) => {
    if (op.op === 'PUT' && (await isPersonalAdminBootstrap(tx, ctx, op.id, op.data))) {
      return allow()
    }
    if (op.op === 'PUT' && (await isSharedWorkspaceAdminBootstrap(tx, ctx, op.data))) {
      return allow()
    }

    // @todo Revisit when the E2EE pipeline supports multi-recipient envelopes
    // and is workspace-aware. Until then, adding a membership for another user
    // on an E2EE-enabled server would produce data they can't decrypt. Self-row
    // bootstraps are exempt (covered above) — the local user already owns the
    // key for their own data. See THU-593.
    if (op.op === 'PUT' && ctx.settings.e2eeEnabled) {
      const targetUserId = typeof op.data?.user_id === 'string' ? op.data.user_id : null
      if (targetUserId && targetUserId !== ctx.userId) {
        return reject('permanent', 'E2EE_MEMBERSHIPS_DISABLED')
      }
    }

    const targetWorkspaceId =
      op.op === 'PUT' ? (typeof op.data?.workspace_id === 'string' ? op.data.workspace_id : null) : null

    // Per-op permission keys read from `workspace_permissions.required_role`.
    // Defaults to admin when the row is absent (Decision 11). Aligned with what
    // the FE Members UI checks via `useWorkspacePermission` so a workspace that
    // grants `member` the permission can actually exercise it on upload.
    const newRole = isRole(op.data?.role) ? op.data.role : null
    const targetsAdminRole = newRole === 'admin'
    if (op.op === 'PUT' && !targetWorkspaceId) {
      const existing = await getMembershipById(tx, op.id)
      if (!existing) {
        return reject('permanent', 'WORKSPACE_ID_REQUIRED')
      }
      if (await isPersonalWorkspace(tx, existing.workspaceId)) {
        return reject('permanent', 'PERSONAL_WORKSPACE_IMMUTABLE')
      }
      if (!(await callerSatisfiesPermission(tx, existing.workspaceId, ctx.userId, 'invite_users'))) {
        return reject('permanent', 'INSUFFICIENT_PERMISSION')
      }
      // Effective role change (either direction) requires `change_roles`.
      // `upsertMembership` overwrites `role` on conflict, so a PUT that
      // changes role would otherwise bypass PATCH's gate.
      const wouldChangeRole = newRole !== null && existing.role !== newRole
      if (
        (wouldChangeRole || targetsAdminRole) &&
        !(await callerSatisfiesPermission(tx, existing.workspaceId, ctx.userId, 'change_roles'))
      ) {
        return reject('permanent', 'INSUFFICIENT_PERMISSION')
      }
      return allow()
    }

    if (op.op === 'PUT') {
      // Insert-or-update path: target workspace is whatever the payload carries.
      if (await isPersonalWorkspace(tx, targetWorkspaceId!)) {
        return reject('permanent', 'PERSONAL_WORKSPACE_IMMUTABLE')
      }
      if (!(await callerSatisfiesPermission(tx, targetWorkspaceId!, ctx.userId, 'invite_users'))) {
        return reject('permanent', 'INSUFFICIENT_PERMISSION')
      }
      // Resolve the existing row at the conflict target `(workspace_id, user_id)`
      // — that's what `upsertMembership` updates, not the row at `op.id`.
      // A PUT changing an existing role (either direction) requires
      // `change_roles`; a fresh insert with `role: 'admin'` also requires it.
      const payloadUserId = typeof op.data?.user_id === 'string' ? op.data.user_id : null
      const existing =
        payloadUserId !== null ? await getMembershipByWorkspaceAndUser(tx, targetWorkspaceId!, payloadUserId) : null
      const wouldChangeRole = existing !== null && newRole !== null && existing.role !== newRole
      const wouldMintNewAdmin = existing === null && targetsAdminRole
      if (
        (wouldChangeRole || wouldMintNewAdmin) &&
        !(await callerSatisfiesPermission(tx, targetWorkspaceId!, ctx.userId, 'change_roles'))
      ) {
        return reject('permanent', 'INSUFFICIENT_PERMISSION')
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
    const permissionKey: 'change_roles' | 'remove_users' = op.op === 'PATCH' ? 'change_roles' : 'remove_users'
    if (!(await callerSatisfiesPermission(tx, existing.workspaceId, ctx.userId, permissionKey))) {
      return reject('permanent', 'INSUFFICIENT_PERMISSION')
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
        // Last-admin protection mirrors PATCH/DELETE. `upsertMembership` does
        // ON CONFLICT DO UPDATE SET role on `(workspace_id, user_id)`, so a
        // PUT demoting the workspace's only admin to member would otherwise
        // bypass the guard those paths enforce.
        const existing = await getMembershipByWorkspaceAndUser(tx, workspaceId, userId)
        if (existing && existing.role === 'admin' && role !== 'admin') {
          const remainingAdmins = await countWorkspaceAdmins(tx, workspaceId, existing.id)
          if (remainingAdmins === 0) {
            throw new UploadRejection('permanent', 'LAST_ADMIN_PROTECTED')
          }
        }
        // Enrich the row with the canonical name/email from `auth.user` so the
        // FE Members page has display info without a synced `users` table. The
        // FE never gets to set these fields directly — the BE is the only
        // source of truth.
        const targetUser = await getUserById(tx, userId)
        if (!targetUser) {
          throw new UploadRejection('permanent', 'USER_NOT_FOUND')
        }
        await upsertMembership(tx, {
          id: op.id,
          workspaceId,
          userId,
          role,
          userName: targetUser.name,
          userEmail: targetUser.email,
        })
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
