/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useActiveWorkspace } from '@/lib/active-workspace'
import { useActiveWorkspaceMembership } from '@/hooks/use-active-workspace-membership'
import Loading from '@/loading'
import { Navigate, Outlet } from 'react-router'

/**
 * Route guard for `/settings/workspace/*`. Personal workspaces fall through —
 * the underlying pages render in a read-only mode so users keep nav access to
 * workspace-scoped tools. Shared workspaces require the active user to be
 * admin; non-admins are redirected to the settings root (`..`), which resolves
 * to `/settings` in the personal tree and `/w/<id>/settings` in the shared
 * tree.
 *
 * The hide-not-disable rule (addendum Decision 25) applies in the sidebar
 * (members don't see the entries). This redirect covers direct URL nav.
 */
export const WorkspaceSettingsGate = () => {
  const active = useActiveWorkspace()
  const { membership, isAdmin } = useActiveWorkspaceMembership()

  if (!active) {
    return <Loading />
  }

  if (active.isPersonal === 1) {
    return <Outlet />
  }

  // Wait for the membership query to resolve before deciding — a freshly-synced
  // membership row should flip the gate without a redirect bounce.
  if (!membership) {
    return <Loading />
  }

  if (!isAdmin) {
    return <Navigate to=".." replace />
  }

  return <Outlet />
}
