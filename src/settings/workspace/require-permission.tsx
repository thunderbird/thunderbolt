/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import type { WorkspacePermissionKey } from '@/dal'
import { useActiveWorkspaceMembership } from '@/hooks/use-active-workspace-membership'
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
  // @todo Drop this E2EE redirect once the encryption pipeline supports
  // multi-recipient envelopes and is workspace-aware (see THU-593). Today an
  // E2EE-enabled server is effectively single-user — member management would
  // produce data the invitee can't decrypt, so we hide the affordance entirely.
  const e2eeEnabled = useConfigStore((state) => state.config.e2eeEnabled === true)

  if (!active) {
    return <Loading />
  }

  if (active.isPersonal === 1) {
    return <Navigate to=".." replace />
  }

  if (e2eeEnabled) {
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

/**
 * Per-route guard for admin-only workspace settings pages (Permissions). Behaviour:
 *
 *   - Personal workspace → redirect to settings root. Decision 25 — Personal
 *     Workspaces have no configurable permissions in v1. Personal users are
 *     admins of their own workspace, so the personal check must run before the
 *     admin check.
 *   - E2EE enabled → redirect. Configuring member-management permissions is
 *     meaningless when there's nothing to manage (THU-593).
 *   - Membership still resolving → render `<Loading />` so the page doesn't
 *     flash on a transient `isAdmin === false`.
 *   - Not admin → redirect to settings root.
 *   - Admin → render `<Outlet />`.
 *
 * The Permissions page itself has no configurable meta-permission (the spec
 * makes it implicitly admin-only), so this guard hardcodes the admin check
 * rather than reading a permission row.
 */
export const RequireWorkspaceAdmin = () => {
  const active = useActiveWorkspace()
  const { isAdmin, isResolved } = useActiveWorkspaceMembership()
  // @todo Drop this E2EE redirect once the encryption pipeline supports
  // multi-recipient envelopes and is workspace-aware (see THU-593). Same gate
  // as RequireWorkspacePermission — the two stay in lockstep.
  const e2eeEnabled = useConfigStore((state) => state.config.e2eeEnabled === true)

  if (!active) {
    return <Loading />
  }

  if (active.isPersonal === 1) {
    return <Navigate to=".." replace />
  }

  if (e2eeEnabled) {
    return <Navigate to=".." replace />
  }

  // `isResolved` distinguishes "still loading" from "confirmed non-member" —
  // without it, a non-member would spin instead of redirecting.
  if (!isResolved) {
    return <Loading />
  }

  if (!isAdmin) {
    return <Navigate to=".." replace />
  }

  return <Outlet />
}
