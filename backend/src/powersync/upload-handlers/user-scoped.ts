/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  powersyncConflictTarget,
  powersyncDbNameToSchemaKey,
  powersyncPkColumn,
  powersyncTablesByName,
} from '@/db/powersync-schema'
import type { PowerSyncTableName } from '@shared/powersync-tables'
import { and, eq } from 'drizzle-orm'
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core'
import { allow, reject, toSchemaRecord } from './helpers'
import { UploadRejection, type UploadHandler } from './types'

export type UserScopedConfig = {
  tableName: PowerSyncTableName
  /** Columns the client may not set; stripped from PUT/PATCH payloads. */
  denyColumns?: readonly string[]
  /** When true, DELETE ops are permanently rejected. */
  denyDelete?: boolean
}

/**
 * Builds an `UploadHandler` for a table whose rows are owned by a single user
 * (the row's `user_id` column always equals the authenticated user). Covers
 * every pre-workspace synced table; the workspace tables get their own handlers.
 *
 * Behavior matches the pre-factory `applyOperation` so this commit is a pure
 * refactor for the existing tables. Workspace-id scoping is layered in commit 3.
 */
export const createUserScopedHandler = (cfg: UserScopedConfig): UploadHandler => {
  const { tableName, denyColumns = [], denyDelete = false } = cfg

  return {
    validate: async (op) => {
      if (op.op === 'DELETE' && denyDelete) {
        return reject('permanent', 'DELETE_NOT_ALLOWED')
      }
      return allow()
    },
    apply: async (op, ctx, tx) => {
      const table = powersyncTablesByName[tableName]
      const dbNameToKey = powersyncDbNameToSchemaKey[tableName]
      const pkColumn = powersyncPkColumn[tableName]
      const conflictTarget = powersyncConflictTarget[tableName]

      const validDbNames = new Set(Object.keys(dbNameToKey))
      // All user-scoped tables carry a `user_id` column for ownership isolation.
      const tableWithUserId = table as AnyPgTable & { userId: AnyPgColumn }

      switch (op.op) {
        case 'PUT': {
          const payload = { ...(op.data ?? {}) } as Record<string, unknown>
          delete payload.id
          delete payload.user_id
          for (const col of denyColumns) {
            delete payload[col]
          }
          const rawData: Record<string, unknown> = { ...payload, id: op.id, user_id: ctx.userId }
          const schemaValues = toSchemaRecord(rawData, validDbNames, dbNameToKey)
          if (Object.keys(schemaValues).length === 0) {
            throw new UploadRejection('permanent', 'EMPTY_PAYLOAD')
          }

          const updateSet = { ...schemaValues }
          delete updateSet.id
          delete updateSet.key
          delete updateSet.userId

          const insertQuery = tx.insert(table).values(schemaValues as never)
          if (Object.keys(updateSet).length > 0) {
            await insertQuery.onConflictDoUpdate({
              target: conflictTarget,
              set: updateSet as never,
              setWhere: eq(tableWithUserId.userId, ctx.userId),
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
          for (const col of denyColumns) {
            delete patchPayload[col]
          }
          const schemaPatch = toSchemaRecord(patchPayload, validDbNames, dbNameToKey)
          if (Object.keys(schemaPatch).length === 0) {
            throw new UploadRejection('permanent', 'EMPTY_PAYLOAD')
          }

          const patched = await tx
            .update(table)
            .set(schemaPatch as never)
            .where(and(eq(pkColumn, op.id), eq(tableWithUserId.userId, ctx.userId)))
            .returning()

          if (patched.length === 0) {
            throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
          }
          return
        }
        case 'DELETE': {
          const deleted = await tx
            .delete(table)
            .where(and(eq(pkColumn, op.id), eq(tableWithUserId.userId, ctx.userId)))
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
