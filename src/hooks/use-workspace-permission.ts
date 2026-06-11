/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import {
  getRequiredRoleForPermissionQuery,
  type WorkspacePermission,
  type WorkspacePermissionKey,
  type WorkspacePermissionRole,
} from '@/dal'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import { useActiveWorkspaceMembership } from '@/hooks/use-active-workspace-membership'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'

/**
 * Default required role per Decision 11 — applied when no `workspace_permissions`
 * row exists yet for the given key. The Permissions page (PR 8) lets admins
 * override these per workspace.
 */
const defaultRequiredRole: WorkspacePermissionRole = 'admin'

export type WorkspacePermissionState = {
  /** Active required role for this key. Falls back to `'admin'` when no row exists. */
  requiredRole: WorkspacePermissionRole
  /** True iff the active user's membership role satisfies `requiredRole`. */
  isAllowed: boolean
  /**
   * True once both the membership and the permission query have returned a
   * definitive answer. While false, treat `isAllowed` as undetermined — the
   * sidebar can hide pending resolution, and route guards should render a
   * loading state rather than redirect.
   */
  isResolved: boolean
}

/**
 * Resolves whether the active user satisfies a workspace permission. Reactive —
 * flips when the membership role changes, when the `workspace_permissions` row
 * is written or deleted, or when the active workspace changes via URL.
 *
 * `requiredRole: 'admin'` means only admins satisfy the permission.
 * `requiredRole: 'member'` means admins AND members both satisfy it.
 */
export const useWorkspacePermission = (permissionKey: WorkspacePermissionKey): WorkspacePermissionState => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const { membership } = useActiveWorkspaceMembership()

  // Live row (if any). Empty result means "no row yet" → default to admin.
  const { data, isPending } = useQuery({
    queryKey: ['workspace-permissions', 'by-key', workspaceId, permissionKey],
    query: toCompilableQuery(getRequiredRoleForPermissionQuery(db, workspaceId ?? '', permissionKey)),
    enabled: !!workspaceId,
  })

  const row = (data?.[0] ?? null) as WorkspacePermission | null
  const requiredRole = row?.requiredRole ?? defaultRequiredRole

  // `isResolved` requires both: a membership row and a permission query that
  // has at least returned once (either a row or an empty result).
  const permissionResolved = !!workspaceId && !isPending
  const isResolved = !!membership && permissionResolved

  const userRole = membership?.role
  const isAllowed =
    isResolved && (requiredRole === 'member' ? userRole === 'admin' || userRole === 'member' : userRole === 'admin')

  return { requiredRole, isAllowed, isResolved }
}
