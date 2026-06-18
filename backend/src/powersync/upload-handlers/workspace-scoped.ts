/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isWorkspaceMember } from '@/dal/workspaces'
import {
  powersyncConflictTarget,
  powersyncDbNameToSchemaKey,
  powersyncPkColumn,
  powersyncTablesByName,
} from '@/db/powersync-schema'
import type { PowerSyncTableName } from '@shared/powersync-tables'
import { type WorkspacePermissionKey } from '@shared/workspaces'
import { and, eq } from 'drizzle-orm'
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core'
import { allow, callerSatisfiesPermission, reject, toSchemaRecord } from './helpers'
import { UploadRejection, type UploadHandler, type UploadTx } from './types'

export type WorkspaceScopedConfig = {
  tableName: PowerSyncTableName
  /**
   * When true, the row's `user_id` column must equal the caller. Applied to
   * chat_threads / chat_messages / tasks per spec §3.7: those rows are user-private
   * within a shared workspace. When false (models, modes, prompts, skills, triggers,
   * mcp_servers, model_profiles) any workspace member may write the row.
   */
  userPrivate: boolean
  /** Columns the client may not set; stripped from PUT/PATCH payloads. */
  denyColumns?: readonly string[]
  /**
   * Permission key gating PUT and "edit" PATCHes. When set, the handler reads
   * `workspace_permissions.required_role` for this key and rejects the op
   * unless the caller's role satisfies it. Default (no key) keeps the "any
   * workspace member may write" behaviour.
   */
  addPermissionKey?: WorkspacePermissionKey
  /**
   * Permission key gating DELETE and "soft-delete" PATCHes (see
   * `softDeleteColumn`). Same lookup semantics as `addPermissionKey`.
   */
  removePermissionKey?: WorkspacePermissionKey
  /**
   * Column name (in PowerSync upload's snake_case form) used by the table for
   * soft-delete tombstones. When set, a PATCH that writes this column to a
   * non-null value is treated as a remove and gates on `removePermissionKey`
   * instead of `addPermissionKey`. PATCHes that don't touch the column — or
   * that set it back to null (restore) — continue to gate as adds.
   *
   * Required for the four resource tables (agents, skills, models,
   * mcp_servers) whose FE DAL soft-deletes via UPDATE rather than DELETE.
   */
  softDeleteColumn?: string
  /**
   * When true, the table carries a `scope` column (`'workspace' | 'user'`) that
   * gates per-row visibility (THU-603). Rows with `scope = 'user'` are private
   * to their author within the workspace: any PATCH/DELETE — and any
   * upsert-style PUT against an existing row — is rejected for callers other
   * than the row owner, in addition to the workspace-membership checks.
   *
   * `scope` is set at create-time only — subsequent PATCHes silently drop it
   * and a PUT-as-update preserves the existing row's scope. PUTs that attempt
   * to set `scope = 'user'` are rejected when `settings.allowUserScopedResources`
   * is false (deployment-level kill switch).
   */
  scopeAware?: boolean
}

const isString = (v: unknown): v is string => typeof v === 'string'

type RowScope = {
  workspaceId: string
  userId: string | null
  /** `'workspace' | 'user'` on scope-aware tables; `null` otherwise. */
  scope: 'workspace' | 'user' | null
}

/**
 * Looks up the existing row's `workspace_id` (and `user_id`, plus `scope` for
 * scope-aware tables) by primary key. Used by PATCH/DELETE validation to
 * discover the workspace the operation targets — composite-PK tables have
 * `(id, workspace_id)` so a bare id match must fan out across whatever rows
 * share the id, but in practice rows are uuid-keyed and globally unique, so
 * the first match is the row.
 */
const fetchRowScope = async (
  tx: UploadTx,
  tableName: PowerSyncTableName,
  rowId: string,
  scopeAware: boolean,
): Promise<RowScope | null> => {
  const table = powersyncTablesByName[tableName] as AnyPgTable & {
    workspaceId: AnyPgColumn
    userId: AnyPgColumn
    scope?: AnyPgColumn
  }
  const pkColumn = powersyncPkColumn[tableName]

  const select: Record<string, AnyPgColumn> = { workspaceId: table.workspaceId, userId: table.userId }
  if (scopeAware && table.scope) {
    select.scope = table.scope
  }

  const rows = await tx.select(select).from(table).where(eq(pkColumn, rowId)).limit(1)

  const row = rows[0]
  if (!row) {
    return null
  }
  const rawScope = (row as { scope?: unknown }).scope
  return {
    workspaceId: row.workspaceId as string,
    userId: (row.userId as string | null) ?? null,
    scope: rawScope === 'user' || rawScope === 'workspace' ? rawScope : null,
  }
}

/**
 * Builds an `UploadHandler` for a workspace-scoped synced table. Enforces:
 *
 * - Every row write requires the caller to be a member of the target workspace.
 *   For PUT, the target is `op.data.workspace_id`; for PATCH/DELETE it's read from
 *   the row's current `workspace_id`.
 * - When `userPrivate` is true, PATCH/DELETE additionally require the row's
 *   `user_id` to equal the caller — protecting one member's chat threads from
 *   being edited by another member of the same workspace.
 * - PUT forces `user_id = ctx.userId` so a client cannot impersonate another
 *   member when authoring rows. PATCH/DELETE silently drop any payload `user_id`.
 * - PATCH/DELETE silently drop any payload `workspace_id` so a row cannot be
 *   moved between workspaces via upload.
 */
export const createWorkspaceScopedHandler = (cfg: WorkspaceScopedConfig): UploadHandler => {
  const {
    tableName,
    userPrivate,
    denyColumns = [],
    addPermissionKey,
    removePermissionKey,
    softDeleteColumn,
    scopeAware = false,
  } = cfg

  /**
   * Classifies the op as 'add' (PUT, PATCH-edit, PATCH-restore) or 'remove'
   * (DELETE, PATCH that sets `softDeleteColumn` to a truthy value). Drives
   * which permission key gates the write.
   */
  const opIntent = (op: { op: 'PUT' | 'PATCH' | 'DELETE'; data?: Record<string, unknown> }): 'add' | 'remove' => {
    if (op.op === 'DELETE') {
      return 'remove'
    }
    if (
      op.op === 'PATCH' &&
      softDeleteColumn !== undefined &&
      op.data &&
      Object.prototype.hasOwnProperty.call(op.data, softDeleteColumn) &&
      op.data[softDeleteColumn] != null
    ) {
      return 'remove'
    }
    return 'add'
  }

  /**
   * True when the row's effective access mode is "private to its author" — either
   * the whole table is userPrivate (chat tables) or the specific row carries
   * `scope = 'user'` (THU-603).
   */
  const isRowOwnerOnly = (rowScope: RowScope): boolean => userPrivate || (scopeAware && rowScope.scope === 'user')

  return {
    validate: async (op, ctx, tx) => {
      if (op.op === 'PUT') {
        const payloadScope = scopeAware && isString(op.data?.scope) ? op.data.scope : null
        if (scopeAware && payloadScope === 'user' && !ctx.settings.allowUserScopedResources) {
          return reject('permanent', 'USER_SCOPE_DISABLED')
        }
        const targetWorkspaceId = isString(op.data?.workspace_id) ? op.data.workspace_id : null
        // For an upsert against an existing row, fall back to the row's workspace
        // if the payload doesn't carry one.
        const existing = await fetchRowScope(tx, tableName, op.id, scopeAware)
        const resolvedWorkspaceId = targetWorkspaceId ?? existing?.workspaceId
        if (!resolvedWorkspaceId) {
          return reject('permanent', 'WORKSPACE_ID_REQUIRED')
        }
        if (!(await isWorkspaceMember(tx, resolvedWorkspaceId, ctx.userId))) {
          return reject('permanent', 'NOT_WORKSPACE_MEMBER')
        }
        // Upsert against an existing user-private row by anyone other than the owner
        // is treated identically to a PATCH against that row — reject so the privacy
        // contract holds across all write ops. Run before the permission check so a
        // non-owner who lacks add permission still gets the more informative reason.
        if (existing && isRowOwnerOnly(existing) && existing.userId !== ctx.userId) {
          return reject('permanent', 'NOT_ROW_OWNER')
        }
        if (
          addPermissionKey &&
          !(await callerSatisfiesPermission(tx, resolvedWorkspaceId, ctx.userId, addPermissionKey))
        ) {
          return reject('permanent', 'INSUFFICIENT_PERMISSION')
        }
        return allow()
      }

      const scope = await fetchRowScope(tx, tableName, op.id, scopeAware)
      if (!scope) {
        return reject('permanent', 'ROW_NOT_FOUND')
      }
      if (!(await isWorkspaceMember(tx, scope.workspaceId, ctx.userId))) {
        return reject('permanent', 'NOT_WORKSPACE_MEMBER')
      }
      if (isRowOwnerOnly(scope) && scope.userId !== ctx.userId) {
        return reject('permanent', 'NOT_ROW_OWNER')
      }
      const requiredPermissionKey = opIntent(op) === 'remove' ? removePermissionKey : addPermissionKey
      if (
        requiredPermissionKey &&
        !(await callerSatisfiesPermission(tx, scope.workspaceId, ctx.userId, requiredPermissionKey))
      ) {
        return reject('permanent', 'INSUFFICIENT_PERMISSION')
      }
      return allow()
    },

    apply: async (op, ctx, tx) => {
      const table = powersyncTablesByName[tableName] as AnyPgTable & {
        workspaceId: AnyPgColumn
        userId: AnyPgColumn
      }
      const dbNameToKey = powersyncDbNameToSchemaKey[tableName]
      const pkColumn = powersyncPkColumn[tableName]
      const conflictTarget = powersyncConflictTarget[tableName]
      const validDbNames = new Set(Object.keys(dbNameToKey))

      switch (op.op) {
        case 'PUT': {
          const targetWorkspaceId = isString(op.data?.workspace_id) ? op.data.workspace_id : null
          const resolvedWorkspaceId =
            targetWorkspaceId ?? (await fetchRowScope(tx, tableName, op.id, scopeAware))?.workspaceId
          if (!resolvedWorkspaceId) {
            throw new UploadRejection('permanent', 'WORKSPACE_ID_REQUIRED')
          }

          const payload = { ...(op.data ?? {}) } as Record<string, unknown>
          delete payload.id
          delete payload.user_id
          delete payload.workspace_id
          for (const col of denyColumns) {
            delete payload[col]
          }

          const rawData: Record<string, unknown> = {
            ...payload,
            id: op.id,
            workspace_id: resolvedWorkspaceId,
            user_id: ctx.userId,
          }
          const schemaValues = toSchemaRecord(rawData, validDbNames, dbNameToKey)
          if (Object.keys(schemaValues).length === 0) {
            throw new UploadRejection('permanent', 'EMPTY_PAYLOAD')
          }

          const updateSet = { ...schemaValues }
          delete updateSet.id
          delete updateSet.key
          delete updateSet.workspaceId
          // Preserve the row's original `user_id` on update so co-members editing a
          // shared row don't rewrite authorship.
          delete updateSet.userId
          // `scope` is set at create-time only — drop it from the ON CONFLICT update
          // so an upsert can't flip a workspace-scoped row to user-scoped or back.
          if (scopeAware) {
            delete (updateSet as { scope?: unknown }).scope
          }

          const insertQuery = tx.insert(table).values(schemaValues as never)
          if (Object.keys(updateSet).length > 0) {
            await insertQuery.onConflictDoUpdate({
              target: conflictTarget,
              set: updateSet as never,
              setWhere: eq(table.workspaceId, resolvedWorkspaceId),
            })
          } else {
            await insertQuery.onConflictDoNothing({ target: conflictTarget })
          }
          return
        }
        case 'PATCH': {
          if (!op.data || Object.keys(op.data).length === 0) {
            return
          }
          const patchPayload = { ...op.data } as Record<string, unknown>
          delete patchPayload.id
          delete patchPayload.user_id
          delete patchPayload.workspace_id
          if (scopeAware) {
            // `scope` is immutable after create — silently drop, mirroring the
            // existing workspace_id / user_id behaviour.
            delete patchPayload.scope
          }
          for (const col of denyColumns) {
            delete patchPayload[col]
          }
          const schemaPatch = toSchemaRecord(patchPayload, validDbNames, dbNameToKey)
          if (Object.keys(schemaPatch).length === 0) {
            throw new UploadRejection('permanent', 'EMPTY_PAYLOAD')
          }

          // Re-fetch scope to pin workspace_id in the WHERE clause. Composite PK
          // (id, workspace_id) means WHERE id alone could touch rows across workspaces.
          const patchScope = await fetchRowScope(tx, tableName, op.id, scopeAware)
          if (!patchScope) {
            throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
          }

          const patched = await tx
            .update(table)
            .set(schemaPatch as never)
            .where(and(eq(pkColumn, op.id), eq(table.workspaceId, patchScope.workspaceId)))
            .returning()

          if (patched.length === 0) {
            throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
          }
          return
        }
        case 'DELETE': {
          const deleteScope = await fetchRowScope(tx, tableName, op.id, scopeAware)
          if (!deleteScope) {
            throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
          }

          const deleted = await tx
            .delete(table)
            .where(and(eq(pkColumn, op.id), eq(table.workspaceId, deleteScope.workspaceId)))
            .returning()

          if (deleted.length === 0) {
            throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
          }
          return
        }
      }
    },
  }
}
