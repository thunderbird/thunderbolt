/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { workspacePermissionsTable } from '../db/tables'
import type { DrizzleQueryWithPromise } from '../types'
import type { WorkspacePermissionKey, WorkspacePermissionRole } from '../../shared/workspaces'

export type { WorkspacePermissionKey, WorkspacePermissionRole }

export type WorkspacePermission = {
  id: string
  workspaceId: string
  permissionKey: WorkspacePermissionKey
  requiredRole: WorkspacePermissionRole
}

export const getPermissionsByWorkspace = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
): Promise<WorkspacePermission[]> => {
  const rows = await db
    .select()
    .from(workspacePermissionsTable)
    .where(eq(workspacePermissionsTable.workspaceId, workspaceId))
    .all()
  return rows as WorkspacePermission[]
}

export const getRequiredRoleForPermission = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  permissionKey: WorkspacePermissionKey,
): Promise<WorkspacePermissionRole | null> => {
  const row = await db
    .select()
    .from(workspacePermissionsTable)
    .where(
      and(
        eq(workspacePermissionsTable.workspaceId, workspaceId),
        eq(workspacePermissionsTable.permissionKey, permissionKey),
      ),
    )
    .get()
  return (row as WorkspacePermission | undefined)?.requiredRole ?? null
}

/**
 * Live Drizzle query for the permission row matching `(workspaceId, permissionKey)`.
 * Use with PowerSync's `toCompilableQuery` for a reactive subscription. Returns
 * an empty result set when no row exists yet — consumers default to `'admin'`
 * (Decision 11) until the Permissions page (PR 8) writes an explicit value.
 */
/**
 * Live Drizzle query for every `workspace_permissions` row on a workspace.
 * Use with PowerSync's `toCompilableQuery` for a reactive subscription.
 */
export const getPermissionsByWorkspaceQuery = (db: AnyDrizzleDatabase, workspaceId: string) => {
  const query = db
    .select()
    .from(workspacePermissionsTable)
    .where(eq(workspacePermissionsTable.workspaceId, workspaceId))
  return query as typeof query & DrizzleQueryWithPromise<WorkspacePermission>
}

/**
 * Reactive hook returning every `workspace_permissions` row for `workspaceId`,
 * along with an `isPending` flag so consumers can disable inputs while the
 * first live result is in-flight. Empty array is the steady-state for a
 * workspace that has never had a Permissions row written (consumers default
 * each key to `'admin'`).
 */
export const useWorkspacePermissionsQuery = (
  workspaceId: string | undefined,
): { rows: WorkspacePermission[]; isPending: boolean } => {
  const db = useDatabase()
  const { data, isPending } = useQuery({
    queryKey: ['workspace-permissions', 'by-workspace', workspaceId],
    query: toCompilableQuery(getPermissionsByWorkspaceQuery(db, workspaceId ?? '')),
    enabled: !!workspaceId,
  })
  return { rows: (data ?? []) as WorkspacePermission[], isPending }
}

export const getRequiredRoleForPermissionQuery = (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  permissionKey: WorkspacePermissionKey,
) => {
  const query = db
    .select()
    .from(workspacePermissionsTable)
    .where(
      and(
        eq(workspacePermissionsTable.workspaceId, workspaceId),
        eq(workspacePermissionsTable.permissionKey, permissionKey),
      ),
    )
    .limit(1)
  return query as typeof query & DrizzleQueryWithPromise<WorkspacePermission>
}

/**
 * Upserts `workspace_permissions.required_role` for `(workspaceId, permissionKey)`.
 * Updates the existing row when present; otherwise inserts a new row with a
 * fresh `uuidv7` id. Defensive against legacy shared workspaces that pre-date
 * the create-time seeding (Decision 11): the page can always write a value
 * without having to know whether the row exists.
 *
 * The BE upload handler authorizes both PATCH and PUT identically
 * (`isWorkspaceAdmin` + reject personal), so either branch round-trips.
 */
export const setWorkspacePermissionRequiredRole = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  permissionKey: WorkspacePermissionKey,
  requiredRole: WorkspacePermissionRole,
): Promise<void> => {
  const existing = await db
    .select({ id: workspacePermissionsTable.id })
    .from(workspacePermissionsTable)
    .where(
      and(
        eq(workspacePermissionsTable.workspaceId, workspaceId),
        eq(workspacePermissionsTable.permissionKey, permissionKey),
      ),
    )
    .get()
  if (existing) {
    await db
      .update(workspacePermissionsTable)
      .set({ requiredRole })
      .where(eq(workspacePermissionsTable.id, existing.id))
    return
  }
  await db.insert(workspacePermissionsTable).values({
    id: uuidv7(),
    workspaceId,
    permissionKey,
    requiredRole,
  })
}
