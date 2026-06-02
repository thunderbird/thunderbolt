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

const personalWorkspaceName = 'Personal'

/**
 * Bootstraps a new real user's workspace state in a single transaction:
 *
 *   1. Insert the user's personal workspace (`is_personal = true`, `owner_user_id = userId`).
 *   2. Insert an `admin` membership row linking the user to that workspace.
 *   3. Promote any pending memberships matching `normalizedEmail` into real memberships
 *      and delete the pending rows.
 *
 * Idempotent across signup retries via the partial-unique index
 * `idx_workspaces_personal_per_owner` and the unique index on
 * `(workspace_id, user_id)` — `ON CONFLICT DO NOTHING` makes a re-run a no-op rather
 * than failing the user-create hook.
 *
 * Called from the Better Auth post-user-create hook. Skipped for anonymous users
 * (Decision 12 — anonymous personal workspaces are FE-created).
 */
export const bootstrapUserWorkspace = async (database: typeof DbType, userId: string, email: string): Promise<void> => {
  const normalizedEmail = normalizeEmail(email)

  await database.transaction(async (tx) => {
    const txDb = tx as unknown as typeof database

    // Resolve-or-create. The partial unique index `idx_workspaces_personal_per_owner`
    // enforces one personal workspace per owner, but `onConflictDoNothing` can't target
    // a partial index — so check first, then insert. Both reads happen inside the tx so
    // a concurrent signup retry can't double-insert.
    const existing = await txDb
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(and(eq(workspacesTable.ownerUserId, userId), eq(workspacesTable.isPersonal, true)))
      .limit(1)

    const personalWorkspaceId = existing[0]?.id ?? uuidv7()

    if (!existing[0]) {
      await txDb.insert(workspacesTable).values({
        id: personalWorkspaceId,
        name: personalWorkspaceName,
        isPersonal: true,
        ownerUserId: userId,
      })
    }

    await txDb
      .insert(workspaceMembershipsTable)
      .values({
        id: uuidv7(),
        workspaceId: personalWorkspaceId,
        userId,
        role: 'admin',
      })
      .onConflictDoNothing({
        target: [workspaceMembershipsTable.workspaceId, workspaceMembershipsTable.userId],
      })

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

export type Role = 'admin' | 'member'
export type WorkspacePermissionKey = 'manage_members' | 'change_roles'

/**
 * Upserts a shared workspace row. `is_personal` is forced to `false` — personal
 * workspaces are server-only and never round-trip through this path. The conflict
 * target is the PK; `name` and `updated_at` are refreshed on conflict.
 */
export const upsertSharedWorkspace = async (
  database: typeof DbType,
  input: { id: string; name: string },
): Promise<void> => {
  await database
    .insert(workspacesTable)
    .values({
      id: input.id,
      name: input.name,
      isPersonal: false,
    })
    .onConflictDoUpdate({
      target: workspacesTable.id,
      set: { name: input.name, updatedAt: new Date() },
    })
}

/**
 * Updates a shared workspace's mutable fields. The `is_personal = false` filter is
 * defense in depth — the upload handler already rejects personal-workspace patches
 * during validation, but the constraint here guarantees the row will not change
 * if a personal workspace ever reaches this path.
 *
 * Returns the affected row count so callers can map 0 → ROW_NOT_FOUND.
 */
export const updateSharedWorkspace = async (
  database: typeof DbType,
  id: string,
  patch: { name?: string },
): Promise<number> => {
  const setClause: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.name !== undefined) {
    setClause.name = patch.name
  }
  const rows = await database
    .update(workspacesTable)
    .set(setClause)
    .where(and(eq(workspacesTable.id, id), eq(workspacesTable.isPersonal, false)))
    .returning()
  return rows.length
}

export type MembershipInput = {
  id: string
  workspaceId: string
  userId: string
  role: Role
}

/**
 * Upserts a workspace membership. Conflict target is the natural key
 * `(workspace_id, user_id)`; on conflict the role is refreshed.
 */
export const upsertMembership = async (database: typeof DbType, input: MembershipInput): Promise<void> => {
  await database
    .insert(workspaceMembershipsTable)
    .values(input)
    .onConflictDoUpdate({
      target: [workspaceMembershipsTable.workspaceId, workspaceMembershipsTable.userId],
      set: { role: input.role },
    })
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
