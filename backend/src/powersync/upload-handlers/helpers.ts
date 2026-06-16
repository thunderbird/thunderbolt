/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getRequiredRoleForPermission, getUserRoleInWorkspace } from '@/dal/workspaces'
import { permissionAllows, type WorkspacePermissionKey } from '@shared/workspaces'
import type { HandlerResult, UploadTx } from './types'

/** Column names Drizzle declares as `timestamp(...)`; JSON sends them as ISO strings. */
const timestampDbColumns = new Set(['deleted_at', 'last_seen', 'created_at', 'revoked_at', 'updated_at'])

/**
 * Map a `{ db_column_name: value }` payload from PowerSync into a Drizzle-ready
 * `{ schemaKey: value }` shape, dropping unknown columns and converting ISO date
 * strings on `timestamp` columns into `Date` instances.
 */
export const toSchemaRecord = (
  dbRecord: Record<string, unknown>,
  validDbNames: Set<string>,
  dbNameToKey: Record<string, string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [dbName, value] of Object.entries(dbRecord)) {
    if (!validDbNames.has(dbName)) {
      continue
    }
    const schemaKey = dbNameToKey[dbName]
    if (schemaKey && value !== undefined) {
      let mapped = value
      if (timestampDbColumns.has(dbName) && typeof value === 'string') {
        const d = new Date(value)
        mapped = Number.isNaN(d.getTime()) ? value : d
      }
      out[schemaKey] = mapped
    }
  }
  return out
}

/** Shorthand result constructors so handler bodies stay terse. */
export const allow = (): HandlerResult => ({ kind: 'apply' })
export const reject = (rejectionClass: 'permanent' | 'transient', code: string): HandlerResult => ({
  kind: 'reject',
  class: rejectionClass,
  code,
})

/**
 * Resolves the caller's role + the configured permission's required role and
 * returns whether the op is allowed. Defaults `required_role` to `'admin'`
 * when no `workspace_permissions` row exists for the key (Decision 11) so an
 * unconfigured workspace stays admin-only. Shared by every handler that gates
 * writes on `workspace_permissions` — keep the lookup in one place so the
 * default-to-admin policy can't drift between tables.
 */
export const callerSatisfiesPermission = async (
  tx: UploadTx,
  workspaceId: string,
  userId: string,
  permissionKey: WorkspacePermissionKey,
): Promise<boolean> => {
  const required = (await getRequiredRoleForPermission(tx, workspaceId, permissionKey)) ?? 'admin'
  const userRole = await getUserRoleInWorkspace(tx, workspaceId, userId)
  return permissionAllows(userRole, required)
}
