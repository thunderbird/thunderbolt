/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import {
  workspaceMembershipsTable,
  workspacePendingMembershipsTable,
  workspacePermissionsTable,
  workspacesTable,
} from '@/db/powersync-schema'
import { normalizeEmail } from '@/lib/email'
import { and, count, eq, ne } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

/**
 * Promotes any pending memberships matching this user's email into real
 * membership rows, atomically with the user creation.
 *
 * Called from the Better Auth post-user-create hook. The personal workspace
 * itself is FE-created (uploaded via PowerSync with a deterministic id from
 * `shared/workspaces.ts`) — the BE no longer creates one here. Pending
 * promotion stays server-side because a brand-new user isn't a member of any
 * workspace yet, so no FE client can see (or act on) the pending invite at
 * signup time.
 *
 * Skipped for anonymous users — anon never receives pending invites.
 */
export const promotePendingMemberships = async (
  database: typeof DbType,
  userId: string,
  email: string,
  name: string,
): Promise<void> => {
  const normalizedEmail = normalizeEmail(email)

  await database.transaction(async (tx) => {
    const txDb = tx as unknown as typeof database

    const pending = await txDb
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.email, normalizedEmail))

    if (pending.length === 0) {
      return
    }

    await txDb
      .insert(workspaceMembershipsTable)
      .values(
        pending.map((row) => ({
          id: uuidv7(),
          workspaceId: row.workspaceId,
          userId,
          role: row.role,
          userName: name,
          userEmail: normalizedEmail,
        })),
      )
      .onConflictDoNothing({
        target: [workspaceMembershipsTable.workspaceId, workspaceMembershipsTable.userId],
      })

    await txDb
      .delete(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.email, normalizedEmail))
  })
}

export type WorkspaceRow = {
  id: string
  isPersonal: boolean
  ownerUserId: string | null
}

export type MembershipRow = {
  id: string
  workspaceId: string
  userId: string
  role: 'admin' | 'member'
}

export type PendingRow = {
  id: string
  workspaceId: string
}

export type PermissionRow = {
  id: string
  workspaceId: string
}

/** Fetches the workspace row for membership/personal checks. Returns `null` if missing. */
export const getWorkspaceById = async (database: typeof DbType, workspaceId: string): Promise<WorkspaceRow | null> => {
  const rows = await database
    .select({
      id: workspacesTable.id,
      isPersonal: workspacesTable.isPersonal,
      ownerUserId: workspacesTable.ownerUserId,
    })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1)
  return rows[0] ?? null
}

export const isPersonalWorkspace = async (database: typeof DbType, workspaceId: string): Promise<boolean> => {
  const row = await getWorkspaceById(database, workspaceId)
  return row?.isPersonal === true
}

export const isWorkspaceMember = async (
  database: typeof DbType,
  workspaceId: string,
  userId: string,
): Promise<boolean> => {
  const rows = await database
    .select({ id: workspaceMembershipsTable.id })
    .from(workspaceMembershipsTable)
    .where(and(eq(workspaceMembershipsTable.workspaceId, workspaceId), eq(workspaceMembershipsTable.userId, userId)))
    .limit(1)
  return rows.length > 0
}

export const isWorkspaceAdmin = async (
  database: typeof DbType,
  workspaceId: string,
  userId: string,
): Promise<boolean> => {
  const rows = await database
    .select({ id: workspaceMembershipsTable.id })
    .from(workspaceMembershipsTable)
    .where(
      and(
        eq(workspaceMembershipsTable.workspaceId, workspaceId),
        eq(workspaceMembershipsTable.userId, userId),
        eq(workspaceMembershipsTable.role, 'admin'),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Returns the user's `role` ('admin' | 'member') for the workspace, or `null`
 * if they have no membership row. Used by upload handlers to evaluate
 * `workspace_permissions.required_role` against the caller's actual role.
 */
export const getUserRoleInWorkspace = async (
  database: typeof DbType,
  workspaceId: string,
  userId: string,
): Promise<Role | null> => {
  const rows = await database
    .select({ role: workspaceMembershipsTable.role })
    .from(workspaceMembershipsTable)
    .where(and(eq(workspaceMembershipsTable.workspaceId, workspaceId), eq(workspaceMembershipsTable.userId, userId)))
    .limit(1)
  const row = rows[0]
  if (!row) {
    return null
  }
  return row.role as Role
}

/**
 * Reads `workspace_permissions.required_role` for `(workspaceId, permissionKey)`.
 * Returns `null` when no row exists yet; callers default to `'admin'`
 * (Decision 11 — the safe default for any new key).
 */
export const getRequiredRoleForPermission = async (
  database: typeof DbType,
  workspaceId: string,
  permissionKey: WorkspacePermissionKey,
): Promise<Role | null> => {
  const rows = await database
    .select({ requiredRole: workspacePermissionsTable.requiredRole })
    .from(workspacePermissionsTable)
    .where(
      and(
        eq(workspacePermissionsTable.workspaceId, workspaceId),
        eq(workspacePermissionsTable.permissionKey, permissionKey),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) {
    return null
  }
  return row.requiredRole as Role
}

/** True when the user is an admin of any workspace (used to gate shared-workspace creation). */
export const isAdminOfAnyWorkspace = async (database: typeof DbType, userId: string): Promise<boolean> => {
  const rows = await database
    .select({ id: workspaceMembershipsTable.id })
    .from(workspaceMembershipsTable)
    .where(and(eq(workspaceMembershipsTable.userId, userId), eq(workspaceMembershipsTable.role, 'admin')))
    .limit(1)
  return rows.length > 0
}

/**
 * Counts admin memberships in a workspace, optionally excluding one membership id.
 * Used for last-admin protection: callers count after the delete inside the same tx
 * and reject when the result would be zero.
 */
/**
 * Counts memberships in a workspace. Used by the bootstrap-admin exception in
 * the membership upload handler: it allows a single admin self-claim for a
 * personal workspace only when the workspace currently has zero memberships.
 */
export const countWorkspaceMemberships = async (database: typeof DbType, workspaceId: string): Promise<number> => {
  const rows = await database
    .select({ value: count() })
    .from(workspaceMembershipsTable)
    .where(eq(workspaceMembershipsTable.workspaceId, workspaceId))
  return Number(rows[0]?.value ?? 0)
}

export const countWorkspaceAdmins = async (
  database: typeof DbType,
  workspaceId: string,
  excludeMembershipId?: string,
): Promise<number> => {
  const baseFilter = and(
    eq(workspaceMembershipsTable.workspaceId, workspaceId),
    eq(workspaceMembershipsTable.role, 'admin'),
  )
  const where = excludeMembershipId
    ? and(baseFilter, ne(workspaceMembershipsTable.id, excludeMembershipId))
    : baseFilter
  const rows = await database.select({ value: count() }).from(workspaceMembershipsTable).where(where)
  return Number(rows[0]?.value ?? 0)
}

export const getMembershipById = async (
  database: typeof DbType,
  membershipId: string,
): Promise<MembershipRow | null> => {
  const rows = await database
    .select({
      id: workspaceMembershipsTable.id,
      workspaceId: workspaceMembershipsTable.workspaceId,
      userId: workspaceMembershipsTable.userId,
      role: workspaceMembershipsTable.role,
    })
    .from(workspaceMembershipsTable)
    .where(eq(workspaceMembershipsTable.id, membershipId))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Look up a membership by `(workspace_id, user_id)` — the unique constraint
 * that `upsertMembership` collides on. Upload-handler validation uses this to
 * detect when a PUT would effectively change an existing role (treated as a
 * PATCH for auth purposes).
 */
export const getMembershipByWorkspaceAndUser = async (
  database: typeof DbType,
  workspaceId: string,
  userId: string,
): Promise<MembershipRow | null> => {
  const rows = await database
    .select({
      id: workspaceMembershipsTable.id,
      workspaceId: workspaceMembershipsTable.workspaceId,
      userId: workspaceMembershipsTable.userId,
      role: workspaceMembershipsTable.role,
    })
    .from(workspaceMembershipsTable)
    .where(and(eq(workspaceMembershipsTable.workspaceId, workspaceId), eq(workspaceMembershipsTable.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

export const getPendingMembershipById = async (database: typeof DbType, id: string): Promise<PendingRow | null> => {
  const rows = await database
    .select({
      id: workspacePendingMembershipsTable.id,
      workspaceId: workspacePendingMembershipsTable.workspaceId,
    })
    .from(workspacePendingMembershipsTable)
    .where(eq(workspacePendingMembershipsTable.id, id))
    .limit(1)
  return rows[0] ?? null
}

export const getWorkspacePermissionById = async (
  database: typeof DbType,
  id: string,
): Promise<PermissionRow | null> => {
  const rows = await database
    .select({
      id: workspacePermissionsTable.id,
      workspaceId: workspacePermissionsTable.workspaceId,
    })
    .from(workspacePermissionsTable)
    .where(eq(workspacePermissionsTable.id, id))
    .limit(1)
  return rows[0] ?? null
}

import type { WorkspacePermissionKey } from '@shared/workspaces'

export type Role = 'admin' | 'member'
export type { WorkspacePermissionKey }

export type UpsertWorkspaceInput = {
  id: string
  name: string
  isPersonal: boolean
  /** Required when `isPersonal` is `true`; null/omitted for shared. */
  ownerUserId?: string | null
  /** Optional slug. Shared-only; personal workspaces never carry one. */
  slug?: string | null
  /** Optional icon (emoji or base64 image). Either workspace kind may set it. */
  icon?: string | null
}

/**
 * Upserts a shared workspace row. Conflict target is the PK; on conflict the
 * mutable fields are refreshed and `updated_at` bumped — covers the admin-
 * rename-via-PUT path even though FE renames now flow through PATCH.
 *
 * Use `insertPersonalWorkspaceIfMissing` for personal workspaces instead — the
 * "do nothing on conflict" semantics avoid clobbering a user rename when a
 * second device runs its idempotent bootstrap PUT.
 */
export const upsertWorkspace = async (database: typeof DbType, input: UpsertWorkspaceInput): Promise<void> => {
  await database
    .insert(workspacesTable)
    .values({
      id: input.id,
      name: input.name,
      slug: input.slug ?? null,
      icon: input.icon ?? null,
      isPersonal: input.isPersonal,
      ownerUserId: input.ownerUserId ?? null,
    })
    .onConflictDoUpdate({
      target: workspacesTable.id,
      set: {
        name: input.name,
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        updatedAt: new Date(),
      },
    })
}

/**
 * Insert a personal workspace row if no row with this id exists. Multi-device
 * safe: device A creates and renames the workspace; device B running its own
 * `ensurePersonalWorkspace` bootstrap re-uploads the canonical PUT with the
 * default name. `ON CONFLICT DO NOTHING` preserves the renamed name on the BE.
 *
 * `slug` is intentionally absent — personal workspaces don't appear in URLs
 * (see THU-551 URL deviation) so the column stays null. `icon` is optional and
 * persisted on first insert only.
 */
export const insertPersonalWorkspaceIfMissing = async (
  database: typeof DbType,
  input: { id: string; name: string; ownerUserId: string; icon?: string | null },
): Promise<void> => {
  await database
    .insert(workspacesTable)
    .values({
      id: input.id,
      name: input.name,
      icon: input.icon ?? null,
      isPersonal: true,
      ownerUserId: input.ownerUserId,
    })
    .onConflictDoNothing({ target: workspacesTable.id })
}

/**
 * Updates a workspace's mutable fields. The upload handler is the only caller
 * and gates writes on admin-of-the-workspace — this just persists the patch.
 *
 * Returns the affected row count so callers can map 0 → ROW_NOT_FOUND.
 */
export const updateWorkspace = async (
  database: typeof DbType,
  id: string,
  patch: { name?: string; slug?: string | null; icon?: string | null },
): Promise<number> => {
  const setClause: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.name !== undefined) {
    setClause.name = patch.name
  }
  if (patch.slug !== undefined) {
    setClause.slug = patch.slug
  }
  if (patch.icon !== undefined) {
    setClause.icon = patch.icon
  }
  const rows = await database.update(workspacesTable).set(setClause).where(eq(workspacesTable.id, id)).returning()
  return rows.length
}

export type MembershipInput = {
  id: string
  workspaceId: string
  userId: string
  role: Role
  /** Denormalized from `auth.user`. Synced down so the Members page can render
   *  display info without a `users` projection table (PowerSync sync rules
   *  can't follow `user_id` across buckets). */
  userName?: string | null
  userEmail?: string | null
}

/**
 * Upserts a workspace membership. Conflict target is the natural key
 * `(workspace_id, user_id)`; on conflict the role is refreshed. Display info
 * (`user_name`, `user_email`) is refreshed too so a stale denormalized row
 * heals the next time the upload handler runs against it.
 */
export const upsertMembership = async (database: typeof DbType, input: MembershipInput): Promise<void> => {
  await database
    .insert(workspaceMembershipsTable)
    .values(input)
    .onConflictDoUpdate({
      target: [workspaceMembershipsTable.workspaceId, workspaceMembershipsTable.userId],
      set: {
        role: input.role,
        ...(input.userName !== undefined ? { userName: input.userName } : {}),
        ...(input.userEmail !== undefined ? { userEmail: input.userEmail } : {}),
      },
    })
}

/**
 * Insert a membership row only if no row with the same `(workspace_id, user_id)`
 * already exists. Used by the promote-on-insert path in the pending-membership
 * upload handler: an invite for an email that already belongs to a member must
 * not overwrite that member's existing role (otherwise an invite for an admin's
 * own email would downgrade them to whatever role the invite carried). Mirrors
 * the `promotePendingMemberships` DO-NOTHING semantics for the signup path.
 */
export const insertMembershipIfMissing = async (database: typeof DbType, input: MembershipInput): Promise<void> => {
  await database
    .insert(workspaceMembershipsTable)
    .values(input)
    .onConflictDoNothing({
      target: [workspaceMembershipsTable.workspaceId, workspaceMembershipsTable.userId],
    })
}

/**
 * Mirrors a user's current display info onto every one of their membership rows.
 * Called from the Better Auth `update.after` hook so name/email changes propagate
 * to co-members on the next sync round-trip. Idempotent — safe to call on every
 * user update regardless of whether name/email actually changed.
 */
export const syncMembershipDisplayInfo = async (
  database: typeof DbType,
  userId: string,
  name: string,
  email: string,
): Promise<void> => {
  await database
    .update(workspaceMembershipsTable)
    .set({ userName: name, userEmail: email })
    .where(eq(workspaceMembershipsTable.userId, userId))
}

export const updateMembership = async (
  database: typeof DbType,
  id: string,
  patch: { role?: Role },
): Promise<number> => {
  if (patch.role === undefined) {
    return 0
  }
  const rows = await database
    .update(workspaceMembershipsTable)
    .set({ role: patch.role })
    .where(eq(workspaceMembershipsTable.id, id))
    .returning()
  return rows.length
}

export const deleteMembership = async (database: typeof DbType, id: string): Promise<number> => {
  const rows = await database.delete(workspaceMembershipsTable).where(eq(workspaceMembershipsTable.id, id)).returning()
  return rows.length
}

export type PendingMembershipInput = {
  id: string
  workspaceId: string
  email: string
  role: Role
  invitedByUserId: string
}

/**
 * Upserts a pending membership row. Email is normalized server-side so case /
 * whitespace variants land on the same record as the Better Auth `before` hook's
 * normalized `user.email`. Conflict target is `(workspace_id, email)`; on conflict
 * the role and inviter are refreshed.
 */
export const upsertPendingMembership = async (
  database: typeof DbType,
  input: PendingMembershipInput,
): Promise<void> => {
  const email = normalizeEmail(input.email)
  await database
    .insert(workspacePendingMembershipsTable)
    .values({ ...input, email })
    .onConflictDoUpdate({
      target: [workspacePendingMembershipsTable.workspaceId, workspacePendingMembershipsTable.email],
      set: { role: input.role, invitedByUserId: input.invitedByUserId },
    })
}

export const updatePendingMembership = async (
  database: typeof DbType,
  id: string,
  patch: { email?: string; role?: Role; invitedByUserId?: string },
): Promise<number> => {
  const setClause: Record<string, unknown> = {}
  if (patch.email !== undefined) {
    setClause.email = normalizeEmail(patch.email)
  }
  if (patch.role !== undefined) {
    setClause.role = patch.role
  }
  if (patch.invitedByUserId !== undefined) {
    setClause.invitedByUserId = patch.invitedByUserId
  }
  if (Object.keys(setClause).length === 0) {
    return 0
  }
  const rows = await database
    .update(workspacePendingMembershipsTable)
    .set(setClause)
    .where(eq(workspacePendingMembershipsTable.id, id))
    .returning()
  return rows.length
}

export const deletePendingMembership = async (database: typeof DbType, id: string): Promise<number> => {
  const rows = await database
    .delete(workspacePendingMembershipsTable)
    .where(eq(workspacePendingMembershipsTable.id, id))
    .returning()
  return rows.length
}

/**
 * Deletes the pending row for `(workspace_id, email)`. Used by the
 * promote-on-insert path in the upload handler: when `upsertPendingMembership`
 * conflicts on the `(workspace_id, email)` unique constraint, Postgres keeps
 * the existing row's id, so a delete keyed on the upload's `op.id` would no-op
 * and leave a stale pending invite behind for someone who is now a real
 * member. Email is normalized to match `upsertPendingMembership`'s storage.
 */
export const deletePendingMembershipByWorkspaceAndEmail = async (
  database: typeof DbType,
  workspaceId: string,
  email: string,
): Promise<number> => {
  const normalizedEmail = normalizeEmail(email)
  const rows = await database
    .delete(workspacePendingMembershipsTable)
    .where(
      and(
        eq(workspacePendingMembershipsTable.workspaceId, workspaceId),
        eq(workspacePendingMembershipsTable.email, normalizedEmail),
      ),
    )
    .returning()
  return rows.length
}

export type WorkspacePermissionInput = {
  id: string
  workspaceId: string
  permissionKey: WorkspacePermissionKey
  requiredRole: Role
}

export const upsertWorkspacePermission = async (
  database: typeof DbType,
  input: WorkspacePermissionInput,
): Promise<void> => {
  await database
    .insert(workspacePermissionsTable)
    .values(input)
    .onConflictDoUpdate({
      target: [workspacePermissionsTable.workspaceId, workspacePermissionsTable.permissionKey],
      set: { requiredRole: input.requiredRole },
    })
}

export const updateWorkspacePermission = async (
  database: typeof DbType,
  id: string,
  patch: { requiredRole?: Role },
): Promise<number> => {
  if (patch.requiredRole === undefined) {
    return 0
  }
  const rows = await database
    .update(workspacePermissionsTable)
    .set({ requiredRole: patch.requiredRole })
    .where(eq(workspacePermissionsTable.id, id))
    .returning()
  return rows.length
}

export const deleteWorkspacePermission = async (database: typeof DbType, id: string): Promise<number> => {
  const rows = await database.delete(workspacePermissionsTable).where(eq(workspacePermissionsTable.id, id)).returning()
  return rows.length
}
