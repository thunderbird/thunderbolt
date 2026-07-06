/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { selectAllowWorkspacePermissionsUi, useConfigStore } from '@/api/config-store'

/**
 * True when the deployment has opted into the workspace Permissions settings
 * page. Gates the route (direct URL nav 404s when disabled), the sidebar entry,
 * and the members-page link. Composed with the existing sidebar visibility
 * rules (personal workspace, admin role, e2ee) at the call site.
 */
export const useWorkspacePermissionsUiEnabled = (): boolean =>
  useConfigStore((state) => selectAllowWorkspacePermissionsUi(state.config))
