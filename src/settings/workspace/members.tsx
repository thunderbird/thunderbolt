/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'

/**
 * Members management for shared workspaces. The `RequireWorkspacePermission`
 * route wrapper gates entry — non-permitted users never see this page. Personal
 * workspaces are blocked at the gate too (Decision 25 — no member management
 * in v1).
 *
 * Subsequent commits land the active + pending table, Add Member dialog,
 * Remove confirmation, and inline role selector.
 */
const WorkspaceMembersPage = () => {
  return (
    <div className="flex flex-col p-4 pb-12 w-full max-w-[760px] mx-auto">
      <PageHeader title="Workspace Members">
        <Button variant="outline" size="lg" disabled>
          Add Member
        </Button>
      </PageHeader>
    </div>
  )
}

export default WorkspaceMembersPage
