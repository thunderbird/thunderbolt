/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { asc, eq } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { workspacePendingMembershipsTable } from '../db/tables'
import type { DrizzleQueryWithPromise } from '../types'

export type WorkspacePendingMembership = {
  id: string
  workspaceId: string
  email: string
  role: 'admin' | 'member'
  invitedByUserId: string
  createdAt: string | null
}

export const getPendingByWorkspace = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
): Promise<WorkspacePendingMembership[]> => {
  const rows = await db
    .select()
    .from(workspacePendingMembershipsTable)
    .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    .all()
  return rows as WorkspacePendingMembership[]
}

/**
 * Live Drizzle query for every pending invite on a workspace, sorted by
 * `email` for stable rendering.
 */
export const getPendingByWorkspaceQuery = (db: AnyDrizzleDatabase, workspaceId: string) => {
  const query = db
    .select()
    .from(workspacePendingMembershipsTable)
    .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    .orderBy(asc(workspacePendingMembershipsTable.email))
  return query as typeof query & DrizzleQueryWithPromise<WorkspacePendingMembership>
}

/**
 * Reactive hook returning every pending invite on `workspaceId`. Returns `[]`
 * until the live query lands rows. Pending rows only sync to admins (see the
 * `workspace_admin_data` bucket), so for non-admins this is always empty.
 */
export const useWorkspacePendingMembershipsQuery = (workspaceId: string | undefined): WorkspacePendingMembership[] => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: ['workspace-pending-memberships', 'by-workspace', workspaceId],
    query: toCompilableQuery(getPendingByWorkspaceQuery(db, workspaceId ?? '')),
    enabled: !!workspaceId,
  })
  return data
}
