/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useDatabase } from '@/contexts'
import {
  setWorkspacePermissionRequiredRole,
  useWorkspacePermissionsQuery,
  type WorkspacePermissionKey,
  type WorkspacePermissionRole,
} from '@/dal'
import { useActiveWorkspaceId } from '@/lib/active-workspace'

/**
 * Rows shown on the Permissions page. Each entry maps a `workspace_permissions`
 * key to its human label. Order is stable and intentional: lifecycle (join /
 * invite / change roles / remove) first, then capability scopes (agents, skills),
 * then admin actions (general settings, permissions, delete). The legacy
 * `manage_members` key is intentionally not listed here — see
 * `project_workspace_permissions_validation_pending`.
 */
const permissionRows: ReadonlyArray<{
  key: WorkspacePermissionKey
  label: string
}> = [
  { key: 'join_workspace', label: 'Join the workspace' },
  { key: 'invite_users', label: 'Invite Users' },
  { key: 'change_roles', label: 'Change Roles' },
  { key: 'remove_users', label: 'Remove Users' },
  { key: 'add_agents', label: 'Add Agents' },
  { key: 'remove_agents', label: 'Remove Agents' },
  { key: 'add_skills', label: 'Add Skills' },
  { key: 'remove_skills', label: 'Remove Skills' },
  { key: 'change_general_settings', label: 'Change General Settings' },
  { key: 'change_permissions', label: 'Change Permissions' },
  { key: 'delete_workspace', label: 'Delete Workspace' },
]

/**
 * Permissions management for shared workspaces. The `RequireWorkspaceAdmin`
 * route wrapper gates entry — non-admins, personal workspaces, and E2EE-enabled
 * servers are all redirected away before this renders (Decision 11, 25).
 *
 * Each row writes through `setWorkspacePermissionRequiredRole`, which upserts
 * the `workspace_permissions` row for the active workspace. The BE upload
 * handler is the authoritative gate (re-checks admin + rejects personal).
 */
const defaultRequiredRole: WorkspacePermissionRole = 'admin'

const WorkspacePermissionsPage = () => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const { rows, isPending } = useWorkspacePermissionsQuery(workspaceId ?? undefined)
  const requiredRoleByKey = new Map<WorkspacePermissionKey, WorkspacePermissionRole>(
    rows.map((row) => [row.permissionKey, row.requiredRole]),
  )

  const handleChange = async (key: WorkspacePermissionKey, value: WorkspacePermissionRole) => {
    if (!workspaceId) {
      return
    }
    await setWorkspacePermissionRequiredRole(db, workspaceId, key, value)
  }

  return (
    <div className="flex flex-col p-4 pb-12 w-full max-w-[760px] mx-auto">
      <PageHeader title="Permissions" />
      <p className="mt-3 text-[length:var(--font-size-sm)] text-muted-foreground">
        Choose which role is required for each action in this workspace.
      </p>
      <Card className="mt-6">
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Permission</TableHead>
                <TableHead>Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {permissionRows.map(({ key, label }) => {
                const value = requiredRoleByKey.get(key) ?? defaultRequiredRole
                return (
                  <TableRow key={key} data-testid={`permission-row-${key}`}>
                    <TableCell>
                      <span className="font-semibold leading-4">{label}</span>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={value}
                        disabled={isPending}
                        onValueChange={(next) => void handleChange(key, next as WorkspacePermissionRole)}
                      >
                        <SelectTrigger className="w-32" aria-label={`Required role for ${label}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="member">Member</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

export default WorkspacePermissionsPage
