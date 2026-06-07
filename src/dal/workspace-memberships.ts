/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { workspaceMembershipsTable } from '../db/tables'

export type WorkspaceMembership = {
  id: string
  workspaceId: string
  userId: string
  role: 'admin' | 'member'
  createdAt: string | null
}

export const getMembership = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMembership | null> => {
  const row = await db
    .select()
    .from(workspaceMembershipsTable)
    .where(and(eq(workspaceMembershipsTable.workspaceId, workspaceId), eq(workspaceMembershipsTable.userId, userId)))
    .get()
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
