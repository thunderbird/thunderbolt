/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WorkspacePermissionKey } from '@/dal'
import { useWorkspacePermission } from '@/hooks/use-workspace-permission'
import { useActiveWorkspace } from '@/lib/active-workspace'
import Loading from '@/loading'
import { Navigate, Outlet } from 'react-router'

type RequireWorkspacePermissionProps = {
  permissionKey: WorkspacePermissionKey
}

/**
 * Per-route guard for permission-gated workspace settings pages (Members,
 * Permissions). Behaviour:
 *
 *   - Personal workspace → redirect to settings root. Decision 25 — Personal
 *     Workspaces can't manage members or permissions in v1.
 *   - Membership or permission row still resolving → render `<Loading />`.
 *   - Permission not satisfied → redirect to settings root.
 *   - Permission satisfied → render `<Outlet />`.
 *
 * The sidebar entry hides at the same time via `useWorkspacePermission`. This
 * guard exists for direct-URL navigation (addendum Decision 25 — hide-not-disable
 * applies in the sidebar; direct URLs still need a guard).
 */
export const RequireWorkspacePermission = ({ permissionKey }: RequireWorkspacePermissionProps) => {
  const active = useActiveWorkspace()
  const { isAllowed, isResolved } = useWorkspacePermission(permissionKey)

  if (!active) {
    return <Loading />
  }

  if (active.isPersonal === 1) {
    return <Navigate to=".." replace />
  }

  if (!isResolved) {
    return <Loading />
  }

  if (!isAllowed) {
    return <Navigate to=".." replace />
  }

  return <Outlet />
}
