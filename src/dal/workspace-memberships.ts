/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { workspaceMembershipsTable } from '../db/tables'
import type { DrizzleQueryWithPromise } from '../types'

export type WorkspaceMembership = {
  id: string
  workspaceId: string
  userId: string
  role: 'admin' | 'member'
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
