/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { SearchInput } from '@/components/ui/search-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  updateMembershipRole,
  updatePendingMembershipRole,
  useWorkspaceMembersQuery,
  useWorkspacePendingMembershipsQuery,
  type WorkspaceMembership,
  type WorkspacePendingMembership,
} from '@/dal'
import { useDatabase } from '@/contexts'
import { useWorkspacePermission } from '@/hooks/use-workspace-permission'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import { InviteMembersModal } from '@/layout/sidebar/invite-members-modal'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

type ActiveRow = { kind: 'active'; row: WorkspaceMembership }
type PendingRow = { kind: 'pending'; row: WorkspacePendingMembership }
type Row = ActiveRow | PendingRow

const roleLabel = (role: 'admin' | 'member'): string => (role === 'admin' ? 'Admin' : 'Member')

/**
 * Members management for shared workspaces. The `RequireWorkspacePermission`
 * route wrapper gates entry — non-permitted users never see this page. Personal
 * workspaces are blocked at the gate too (Decision 25 — no member management
 * in v1).
 */
const WorkspaceMembersPage = () => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId() ?? undefined
  const actives = useWorkspaceMembersQuery(workspaceId)
  const pendings = useWorkspacePendingMembershipsQuery(workspaceId)
  const { isAllowed: canChangeRoles } = useWorkspacePermission('change_roles')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim().toLowerCase()

  // The local last-admin computation backs the demote-disable UX. The BE upload
  // handler enforces the same constraint authoritatively — this just keeps the
  // user from picking an option that will round-trip-fail.
  const adminCount = actives.filter((row) => row.role === 'admin').length

  // Pending rows render first — invites at the top of the list keep the
  // outstanding-actions affordances together (Add Member → invite → resolve).
  const filteredPendings = normalizedSearch
    ? pendings.filter((row) => row.email.toLowerCase().includes(normalizedSearch))
    : pendings
  const filteredActives = normalizedSearch
    ? actives.filter(
        (row) =>
          row.userName?.toLowerCase().includes(normalizedSearch) ||
          row.userEmail?.toLowerCase().includes(normalizedSearch) ||
          row.userId.toLowerCase().includes(normalizedSearch),
      )
    : actives
  const rows: Row[] = [
    ...filteredPendings.map((row): PendingRow => ({ kind: 'pending', row })),
    ...filteredActives.map((row): ActiveRow => ({ kind: 'active', row })),
  ]

  const handleActiveRoleChange = async (membershipId: string, role: 'admin' | 'member') => {
    await updateMembershipRole(db, membershipId, role)
  }

  const handlePendingRoleChange = async (pendingId: string, role: 'admin' | 'member') => {
    await updatePendingMembershipRole(db, pendingId, role)
  }

  return (
    <div className="flex flex-col p-4 pb-12 w-full max-w-[760px] mx-auto">
      <PageHeader title="Members" />
      <p className="mt-3 text-[length:var(--font-size-sm)] text-muted-foreground">
        Manage people in your workspace. To change roles, go to{' '}
        <Link to="../permissions" relative="route" className="underline underline-offset-2 hover:text-foreground">
          Permissions
        </Link>
        .
      </p>
      <div className="mt-6 mb-4 flex items-center gap-2">
        <SearchInput
          showIcon
          placeholder="Search Users"
          containerClassName="flex-1"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button variant="outline" size="lg" onClick={() => setInviteOpen(true)} disabled={!workspaceId}>
          <Plus className="size-4" />
          Add Member
        </Button>
      </div>
      <Card>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="pl-5">Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead aria-label="Actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((entry) =>
                  entry.kind === 'active' ? (
                    <TableRow key={`active-${entry.row.id}`} data-testid={`member-row-${entry.row.userId}`}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-semibold text-[length:var(--font-size-xs)] leading-4">
                            {entry.row.userName ?? entry.row.userId}
                          </span>
                          {entry.row.userEmail && (
                            <span className="font-normal text-[length:var(--font-size-xs)] leading-4 text-muted-foreground">
                              {entry.row.userEmail}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {canChangeRoles ? (
                          <Select
                            value={entry.row.role}
                            onValueChange={(value) =>
                              void handleActiveRoleChange(entry.row.id, value as 'admin' | 'member')
                            }
                          >
                            <SelectTrigger
                              className="w-26 border-0 shadow-none bg-transparent dark:bg-transparent hover:bg-accent dark:hover:bg-accent"
                              aria-label={`Role for ${entry.row.userName ?? entry.row.userId}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="member" disabled={entry.row.role === 'admin' && adminCount <= 1}>
                                Member
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <span>{roleLabel(entry.row.role)}</span>
                        )}
                      </TableCell>
                      <TableCell>Joined</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" disabled>
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={`pending-${entry.row.id}`} data-testid={`pending-row-${entry.row.email}`}>
                      <TableCell>
                        <span className="font-normal text-[length:var(--font-size-xs)] leading-4 text-muted-foreground">
                          {entry.row.email}
                        </span>
                      </TableCell>
                      <TableCell>
                        {canChangeRoles ? (
                          <Select
                            value={entry.row.role}
                            onValueChange={(value) =>
                              void handlePendingRoleChange(entry.row.id, value as 'admin' | 'member')
                            }
                          >
                            <SelectTrigger
                              className="w-26 border-0 shadow-none bg-transparent dark:bg-transparent hover:bg-accent dark:hover:bg-accent"
                              aria-label={`Role for ${entry.row.email}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="member">Member</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <span>{roleLabel(entry.row.role)}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">Pending</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" disabled>
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <InviteMembersModal open={inviteOpen} workspaceId={workspaceId ?? null} onClose={() => setInviteOpen(false)} />
    </div>
  )
}

export default WorkspaceMembersPage
