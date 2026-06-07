/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { workspacePermissionsTable } from '../db/tables'

export type WorkspacePermissionKey = 'manage_members' | 'change_roles'
export type WorkspacePermissionRole = 'admin' | 'member'

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
