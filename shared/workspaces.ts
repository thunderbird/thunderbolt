/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { v5 as uuidv5 } from 'uuid'

/**
 * Fixed UUID namespace for deriving deterministic personal workspace and
 * admin-membership ids from a user id. Do not change — changing this constant
 * orphans every existing personal workspace.
 */
const PERSONAL_WORKSPACE_NAMESPACE = 'e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'

/**
 * Derive the canonical personal workspace id for a user.
 *
 * The personal workspace is FE-created on first sign-in and uploaded via
 * PowerSync. Multiple devices that sign in for the same account independently
 * compute the same id and upload the same row, so concurrent first-sign-ins
 * become idempotent upserts on the BE rather than a partial-unique-index race.
 *
 * Used as the canonical anchor in the BE upload handler — the personal
 * workspace PUT is accepted only when `op.id === computePersonalWorkspaceId(ctx.userId)`.
 */
export const computePersonalWorkspaceId = (userId: string): string =>
  uuidv5(`personal:${userId}`, PERSONAL_WORKSPACE_NAMESPACE)

/**
 * Derive the canonical admin-membership id for a user's personal workspace.
 *
 * Same rationale as the workspace id — two devices uploading the bootstrap
 * admin membership for the same user end up with the same row id, so the
 * upload becomes an upsert no-op rather than two rows pointing at the same
 * `(workspace_id, user_id)` natural key (which the unique constraint would
 * reject for the second device).
 */
export const computePersonalAdminMembershipId = (userId: string): string =>
  uuidv5(`personal-admin:${userId}`, PERSONAL_WORKSPACE_NAMESPACE)

/**
 * Single source of truth for the keys that may appear in the
 * `workspace_permissions.permission_key` column. Order matches the rendering
 * order of the Permissions settings page (lifecycle → capabilities → admin).
 *
 * `manage_members` is a legacy key superseded by per-operation gates
 * (`invite_users`/`change_roles`/`remove_users`). Kept in the union so older
 * `workspace_permissions` rows still type-check; not surfaced on the
 * Permissions page and not consulted by any route guard or upload handler.
 *
 * Add a new key here, then the FE/BE schemas, the FE/BE types, and the upload
 * handler's runtime check all stay in sync via this constant.
 */
export const workspacePermissionKeys = [
  'manage_members',
  'join_workspace',
  'invite_users',
  'change_roles',
  'remove_users',
  'add_agents',
  'remove_agents',
  'add_skills',
  'remove_skills',
  'add_models',
  'remove_models',
  'change_general_settings',
  'change_permissions',
  'delete_workspace',
] as const

export type WorkspacePermissionKey = (typeof workspacePermissionKeys)[number]

/** The two role buckets used by both `workspace_memberships.role` and `workspace_permissions.required_role`. */
export const workspacePermissionRoles = ['admin', 'member'] as const

export type WorkspacePermissionRole = (typeof workspacePermissionRoles)[number]

/** Runtime narrowing for upload-handler payloads — checks `v` against `workspacePermissionKeys`. */
export const isWorkspacePermissionKey = (v: unknown): v is WorkspacePermissionKey =>
  typeof v === 'string' && (workspacePermissionKeys as readonly string[]).includes(v)

/** Runtime narrowing for upload-handler payloads — checks `v` against `workspacePermissionRoles`. */
export const isWorkspacePermissionRole = (v: unknown): v is WorkspacePermissionRole =>
  typeof v === 'string' && (workspacePermissionRoles as readonly string[]).includes(v)

/**
 * Whether `userRole` satisfies a `requiredRole` policy. Admins always satisfy;
 * a `member` requirement is satisfied by both admins and members.
 *
 * Shared between FE (`useWorkspacePermission`) and BE (upload handler authz)
 * so the same predicate gates UI affordances and write enforcement.
 */
export const permissionAllows = (
  userRole: WorkspacePermissionRole | null | undefined,
  requiredRole: WorkspacePermissionRole,
): boolean => {
  if (!userRole) {
    return false
  }
  if (userRole === 'admin') {
    return true
  }
  return requiredRole === 'member'
}
