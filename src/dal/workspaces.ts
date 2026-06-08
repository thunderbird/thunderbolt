/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { workspaceMembershipsTable, workspacesTable } from '../db/tables'
import type { DrizzleQueryWithPromise } from '../types'
import { computePersonalAdminMembershipId, computePersonalWorkspaceId } from '@shared/workspaces'

export type Workspace = {
  id: string
  name: string
  isPersonal: number
  ownerUserId: string | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * Drizzle query for the personal workspace owned by `userId`. Use with
 * PowerSync's `toCompilableQuery` (live React subscription) or `await` for a
 * one-shot read. Single source of truth for the personal-workspace WHERE
 * clause — `getPersonalWorkspaceByOwner` and `useActiveWorkspaceId` both go
 * through this so they can't drift.
 */
export const getPersonalWorkspaceByOwnerQuery = (db: AnyDrizzleDatabase, userId: string) => {
  const query = db
    .select()
    .from(workspacesTable)
    .where(and(eq(workspacesTable.ownerUserId, userId), eq(workspacesTable.isPersonal, 1)))
    .limit(1)
  return query as typeof query & DrizzleQueryWithPromise<Workspace>
}

/**
 * Look up the personal workspace for a given user. Returns `null` if the row
 * hasn't synced down yet (first signup) or if the user has none — the boot path
 * awaits this becoming non-null before proceeding to reconcile defaults.
 */
export const getPersonalWorkspaceByOwner = async (
  db: AnyDrizzleDatabase,
  userId: string,
): Promise<Workspace | null> => {
  const row = await getPersonalWorkspaceByOwnerQuery(db, userId).get()
  return (row ?? null) as Workspace | null
}

/**
 * Drizzle query for a workspace by id. Use with PowerSync's `toCompilableQuery`
 * for a live subscription (the active-workspace hook does this when the URL
 * carries a `/w/<id>/` prefix).
 */
export const getWorkspaceByIdQuery = (db: AnyDrizzleDatabase, id: string) => {
  const query = db.select().from(workspacesTable).where(eq(workspacesTable.id, id)).limit(1)
  return query as typeof query & DrizzleQueryWithPromise<Workspace>
}

/** Fetch a workspace by id. Used by the URL-driven workspace selector. */
export const getWorkspaceById = async (db: AnyDrizzleDatabase, id: string): Promise<Workspace | null> => {
  const row = await getWorkspaceByIdQuery(db, id).get()
  return (row ?? null) as Workspace | null
}

/**
 * Resolve or create the user's personal workspace locally.
 *
 * The personal workspace + admin membership are FE-created with deterministic
 * ids (`shared/workspaces.ts`). Multi-device safe by construction — every
 * device computes the same id and uploads the same row, so PowerSync uploads
 * become upserts on the BE rather than racing for a unique constraint.
 *
 * Called from `runPostAuthBootstrap` once a session is established. No sync
 * dependency: the workspace is usable immediately, sync uploads it (and any
 * later edits) when the user enables sync.
 */
export const ensurePersonalWorkspace = async (db: AnyDrizzleDatabase, userId: string): Promise<Workspace> => {
  const existing = await getPersonalWorkspaceByOwner(db, userId)
  if (existing) {
    return existing
  }

  const workspaceId = computePersonalWorkspaceId(userId)
  const membershipId = computePersonalAdminMembershipId(userId)

  await db.transaction(async (tx) => {
    await tx.insert(workspacesTable).values({
      id: workspaceId,
      name: 'Personal',
      isPersonal: 1,
      ownerUserId: userId,
    })
    await tx.insert(workspaceMembershipsTable).values({
      id: membershipId,
      workspaceId,
      userId,
      role: 'admin',
    })
  })

  const created = await getPersonalWorkspaceByOwner(db, userId)
  if (!created) {
    throw new Error(`Failed to create personal workspace for user ${userId}`)
  }
  return created
}
