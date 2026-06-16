/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { asc, eq } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { v7 as uuidv7 } from 'uuid'
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
 * until the live query lands rows. Pending rows sync to every workspace
 * member (see the `workspace_data` bucket) so non-admins with
 * `invite_users` / `change_roles` / `remove_users` can still see and act on
 * the invite list.
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

export type AddPendingMembershipInput = {
  workspaceId: string
  email: string
  invitedByUserId: string
  /** Defaults to `'member'`. */
  role?: 'admin' | 'member'
}

/**
 * Inserts a single `workspace_pending_memberships` row. Email is lowercased +
 * trimmed before write to match the BE's normalization (so cross-device
 * variants land on the same `(workspace_id, email)` natural key). Throws on
 * empty input; format validation stays at the UI layer.
 *
 * The BE upload handler promotes the pending row to an active membership when
 * the invited email belongs to an existing user; otherwise the row stays
 * pending until the invitee signs up.
 *
 * Returns the new row id.
 */
export const addPendingMembership = async (
  db: AnyDrizzleDatabase,
  input: AddPendingMembershipInput,
): Promise<string> => {
  const email = input.email.toLowerCase().trim()
  if (!email) {
    throw new Error('Email is required')
  }
  const id = uuidv7()
  await db.insert(workspacePendingMembershipsTable).values({
    id,
    workspaceId: input.workspaceId,
    email,
    role: input.role ?? 'member',
    invitedByUserId: input.invitedByUserId,
  })
  return id
}

/**
 * Updates the role on a pending invite row. Same permission semantics as
 * `updateMembershipRole` — the BE upload handler enforces admin-of-workspace.
 * No last-admin protection applies here: pending rows aren't yet admins.
 */
export const updatePendingMembershipRole = async (
  db: AnyDrizzleDatabase,
  pendingId: string,
  role: 'admin' | 'member',
): Promise<void> => {
  await db
    .update(workspacePendingMembershipsTable)
    .set({ role })
    .where(eq(workspacePendingMembershipsTable.id, pendingId))
}

/**
 * Deletes a pending invite row. The BE upload handler enforces
 * admin-of-workspace + personal-workspace immutability.
 */
export const removePendingMembership = async (db: AnyDrizzleDatabase, pendingId: string): Promise<void> => {
  await db.delete(workspacePendingMembershipsTable).where(eq(workspacePendingMembershipsTable.id, pendingId))
}
