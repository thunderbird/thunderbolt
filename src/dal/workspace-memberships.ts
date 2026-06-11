/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, eq } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { workspaceMembershipsTable } from '../db/tables'
import type { DrizzleQueryWithPromise } from '../types'

export type WorkspaceMembership = {
  id: string
  workspaceId: string
  userId: string
  role: 'admin' | 'member'
  /** Denormalized from `auth.user`. `null` only on rows synced before commit 1's
   *  backfill landed; treat that as "unknown" in the UI (fall back to the userId). */
  userName: string | null
  userEmail: string | null
  createdAt: string | null
}

/**
 * Drizzle query for the membership row matching `(workspaceId, userId)`. Use
 * with PowerSync's `toCompilableQuery` for a live subscription — the route
 * guard listens to this so a freshly-synced membership flips the gate without
 * a manual refetch.
 */
export const getMembershipQuery = (db: AnyDrizzleDatabase, workspaceId: string, userId: string) => {
  const query = db
    .select()
    .from(workspaceMembershipsTable)
    .where(and(eq(workspaceMembershipsTable.workspaceId, workspaceId), eq(workspaceMembershipsTable.userId, userId)))
    .limit(1)
  return query as typeof query & DrizzleQueryWithPromise<WorkspaceMembership>
}

export const getMembership = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMembership | null> => {
  const row = await getMembershipQuery(db, workspaceId, userId).get()
  return (row ?? null) as WorkspaceMembership | null
}

export const getMembershipsByWorkspace = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
): Promise<WorkspaceMembership[]> => {
  const rows = await db
    .select()
    .from(workspaceMembershipsTable)
    .where(eq(workspaceMembershipsTable.workspaceId, workspaceId))
    .all()
  return rows as WorkspaceMembership[]
}

/**
 * Live Drizzle query for every membership in a workspace, sorted by
 * `userName` (case-insensitive on SQLite's default collation) then `userId`
 * for stable rendering when names tie or haven't synced yet.
 */
export const getMembershipsByWorkspaceQuery = (db: AnyDrizzleDatabase, workspaceId: string) => {
  const query = db
    .select()
    .from(workspaceMembershipsTable)
    .where(eq(workspaceMembershipsTable.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembershipsTable.userName), asc(workspaceMembershipsTable.userId))
  return query as typeof query & DrizzleQueryWithPromise<WorkspaceMembership>
}

/**
 * Reactive hook returning every membership in `workspaceId`. Returns `[]` until
 * either `workspaceId` resolves or the live query lands rows. Consumers that
 * need a loading state can wrap the underlying React Query themselves — the
 * Members page only needs the array.
 */
export const useWorkspaceMembersQuery = (workspaceId: string | undefined): WorkspaceMembership[] => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: ['workspace-memberships', 'by-workspace', workspaceId],
    query: toCompilableQuery(getMembershipsByWorkspaceQuery(db, workspaceId ?? '')),
    enabled: !!workspaceId,
  })
  return data
}

export const getMembershipsByUser = async (db: AnyDrizzleDatabase, userId: string): Promise<WorkspaceMembership[]> => {
  const rows = await db
    .select()
    .from(workspaceMembershipsTable)
    .where(eq(workspaceMembershipsTable.userId, userId))
    .all()
  return rows as WorkspaceMembership[]
}

export const isWorkspaceAdmin = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  userId: string,
): Promise<boolean> => {
  const membership = await getMembership(db, workspaceId, userId)
  return membership?.role === 'admin'
}

/**
 * Updates the role on a membership row. The BE upload handler enforces
 * admin-of-workspace + last-admin protection — this DAL is a thin write that
 * PowerSync emits as a PATCH. UI must hide the affordance for the last admin
 * (see `RoleSelector` gating) as a UX backstop.
 */
export const updateMembershipRole = async (
  db: AnyDrizzleDatabase,
  membershipId: string,
  role: 'admin' | 'member',
): Promise<void> => {
  await db.update(workspaceMembershipsTable).set({ role }).where(eq(workspaceMembershipsTable.id, membershipId))
}

/**
 * Deletes a membership row. The BE upload handler enforces admin-of-workspace
 * + last-admin protection + personal-workspace immutability. UI must hide the
 * Remove button for the last admin row.
 */
export const removeMembership = async (db: AnyDrizzleDatabase, membershipId: string): Promise<void> => {
  await db.delete(workspaceMembershipsTable).where(eq(workspaceMembershipsTable.id, membershipId))
}
