/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { workspaceMembershipsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { v7 as uuidv7 } from 'uuid'
import { exportFormat, exportSchemaVersion, exportedTableNames, includedTables, type IncludedTableName } from './export'

type PkSpec = {
  /** Drizzle column reference, used in `WHERE` clauses. */
  column: SQLiteColumn
  /** JS/TypeScript field name on the row — sometimes differs from the SQL column name. */
  field: string
}

/**
 * Find the single primary-key column on a Drizzle table and the JS field name
 * that exposes it. Throws if the table doesn't have exactly one PK column —
 * every table in {@link includedTables} satisfies that today, and a future
 * composite-PK table would need bespoke import logic anyway.
 *
 * Exported for unit-test coverage of the failure branches; not part of the
 * public DAL API.
 */
export const derivePkSpec = (tableName: string, table: SQLiteTable): PkSpec => {
  const config = getTableConfig(table)
  const pkColumns = config.columns.filter((c) => c.primary)
  if (pkColumns.length !== 1) {
    throw new Error(
      `Table "${tableName}" must have exactly one primary-key column for import (found ${pkColumns.length}).`,
    )
  }
  const column = pkColumns[0] as SQLiteColumn
  // Drizzle exposes each column as an enumerable string-keyed property on the
  // table; match by reference to recover the JS field name (which can differ
  // from the SQL column name — e.g. `settingsTable.key` maps to SQL `id`).
  // Skip Drizzle's internal `_` config bag so it never collides with a column ref.
  const candidates = Object.entries(table as unknown as Record<string, unknown>).filter(([key]) => key !== '_')
  const entry = candidates.find(([, value]) => value === column)
  if (!entry) {
    throw new Error(`Could not derive JS field name for the primary key of "${tableName}".`)
  }
  return { column, field: entry[0] }
}

type TableImportSpec = {
  pk: PkSpec
  /** JS field names on the row whose value identifies a user (e.g. `userId`,
   *  `ownerUserId`, `invitedByUserId`). On import these are stripped from the
   *  file row and rewritten with the current session user — the file value is
   *  never trusted. Empty for tables (e.g. secrets) that have no such columns. */
  userIdFields: string[]
  /** True when the table has a `workspace_id` column. Pre-workspaces-v1
   *  backups have no `workspaceId` on their rows; on import we fall back to the
   *  importing user's personal workspace so the data is visible in the UI
   *  instead of orphaned with `workspace_id = NULL`. */
  hasWorkspaceId: boolean
}

/** SQL column-name predicate: matches `user_id`, `owner_user_id`,
 *  `invited_by_user_id`, etc. Used to flag every user-FK column for re-stamping
 *  so a workspaces / pending-membership row can't plant a foreign user id. */
const isUserIdColumnName = (name: string): boolean => name === 'user_id' || name.endsWith('_user_id')

/** Resolve the JS field name on a Drizzle table whose value === `column`.
 *  Drizzle exposes each column as an enumerable property on the table;
 *  matching by reference recovers the field name even when it differs from
 *  the SQL column name. Skip the internal `_` config bag. */
const findJsFieldName = (table: SQLiteTable, column: SQLiteColumn): string | null => {
  const candidates = Object.entries(table as unknown as Record<string, unknown>).filter(([key]) => key !== '_')
  return candidates.find(([, value]) => value === column)?.[0] ?? null
}

const deriveUserIdFields = (tableName: string, table: SQLiteTable): string[] => {
  const fields: string[] = []
  for (const column of getTableConfig(table).columns) {
    if (!isUserIdColumnName(column.name)) {
      continue
    }
    const field = findJsFieldName(table, column as SQLiteColumn)
    if (!field) {
      throw new Error(`Could not derive JS field name for user-id column "${column.name}" on "${tableName}".`)
    }
    fields.push(field)
  }
  return fields
}

/**
 * Per-table import spec, derived once at module load from the same
 * `includedTables` map the exporter walks. New tables in
 * `src/db/powersync/schema.ts` automatically pick up an import spec — no
 * duplicate hardcoded list to keep in sync.
 */
const tableImportSpecs = Object.fromEntries(
  (Object.entries(includedTables) as Array<[IncludedTableName, SQLiteTable]>).map(([name, table]) => [
    name,
    {
      pk: derivePkSpec(name, table),
      userIdFields: deriveUserIdFields(name, table),
      hasWorkspaceId: getTableConfig(table).columns.some((c) => c.name === 'workspace_id'),
    },
  ]),
) as Record<IncludedTableName, TableImportSpec>

export type ImportResult = {
  schemaVersion: typeof exportSchemaVersion
  /** Number of rows upserted per included table. Omitted tables had zero rows in the file. */
  tables: Partial<Record<IncludedTableName, { upserted: number }>>
  /** Table keys present in the file that the importer didn't recognize (forward-compat with future schemaVersions). */
  ignoredTableNames: string[]
}

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportFormatError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isIncludedTableName = (name: string): name is IncludedTableName =>
  (exportedTableNames as readonly string[]).includes(name)

export type ExportSummary = {
  /** Total row count across every array-valued bucket in `tables`. */
  totalRows: number
  /** Locale-formatted `exportedAt`, or null if it's missing / unparseable. */
  exportedAtLabel: string | null
  /** Email of the exporting user, or null if it's missing / not a string. */
  sourceEmail: string | null
  /**
   * `true` when both `sourceEmail` and `currentUserEmail` are present and
   * differ (case-insensitively). The UI uses this to flag a cross-account
   * import in the confirm dialog. Stays `false` when either side is missing
   * — better to under-warn than to false-positive on legacy exports.
   */
  accountMismatch: boolean
}

/**
 * Read-only preview of an import envelope for the confirmation dialog.
 *
 * Returns `null` when the payload doesn't look like a valid v1 Thunderbolt
 * export (wrong shape, wrong format slug, wrong/unsupported `schemaVersion`,
 * or missing `tables`). The UI uses that to refuse the preview without
 * having to re-implement envelope checks; the full
 * {@link importUserData} validator covers the same ground at write time.
 *
 * Pass `currentUserEmail` to enable cross-account detection — the returned
 * `accountMismatch` flag is set when the envelope's email and the session
 * email both exist and differ. Email (not `user.id`) is the comparison
 * field: better-auth assigns a new id when an account is deleted and
 * recreated, but the same human's email stays stable.
 */
export const summarizeExportEnvelope = (
  payload: unknown,
  currentUserEmail: string | null = null,
): ExportSummary | null => {
  if (!isRecord(payload)) {
    return null
  }
  if (payload.format !== exportFormat) {
    return null
  }
  if (payload.schemaVersion !== exportSchemaVersion) {
    return null
  }
  if (!isRecord(payload.tables)) {
    return null
  }
  const totalRows = Object.values(payload.tables).reduce<number>(
    (sum, value) => sum + (Array.isArray(value) ? value.length : 0),
    0,
  )
  const exportedAtLabel =
    typeof payload.exportedAt === 'string'
      ? (() => {
          const parsed = new Date(payload.exportedAt)
          return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleDateString()
        })()
      : null
  const sourceEmail = isRecord(payload.user) && typeof payload.user.email === 'string' ? payload.user.email : null
  const accountMismatch =
    sourceEmail !== null && currentUserEmail !== null && sourceEmail.toLowerCase() !== currentUserEmail.toLowerCase()
  return { totalRows, exportedAtLabel, sourceEmail, accountMismatch }
}

/** JS-side counterpart to {@link isUserIdColumnName}: matches `userId`,
 *  `ownerUserId`, `invitedByUserId`, etc. Used to strip every user-FK field
 *  off a file row before re-stamping the columns the target table actually
 *  has. Drops blindly so a rogue file value never survives even on a table
 *  that has no user column at all (e.g. the secret tables). */
const isUserIdFieldName = (name: string): boolean => name === 'userId' || name.endsWith('UserId')

/**
 * Strip every user-id field from the file row, re-stamp the columns the
 * target table actually has with the current session user, and back-fill
 * `workspaceId` with the importing user's personal workspace when the file
 * row is missing one (pre-workspaces-v1 backups).
 *
 * User-id re-stamping covers `user_id`, `owner_user_id`, `invited_by_user_id`,
 * and any future user-FK column — detection is column-name based, not
 * table-name based. Backups carry the source user's id, but a tampered or
 * cross-account file would otherwise plant a foreign id in the local DB
 * until backend reconciliation. The backend's PowerSync upload route
 * enforces the same invariant from the JWT (see
 * `backend/src/dal/powersync.ts`).
 *
 * The `workspaceId` rule is fallback-only: a modern multi-workspace backup
 * carries `workspaceId` on every per-user row, and we preserve those values
 * so a restore reinstates the source's workspace structure. Only rows that
 * arrive without one (legacy v1 backups) get attached to the personal
 * workspace so they're visible to the UI instead of orphaned at NULL.
 */
const sanitizeRowForImport = (
  row: Record<string, unknown>,
  userIdFields: string[],
  hasWorkspaceId: boolean,
  currentUserId: string,
  personalWorkspaceId: string,
): Record<string, unknown> => {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (!isUserIdFieldName(key)) {
      sanitized[key] = value
    }
  }
  for (const field of userIdFields) {
    sanitized[field] = currentUserId
  }
  if (hasWorkspaceId && (sanitized.workspaceId === undefined || sanitized.workspaceId === null)) {
    sanitized.workspaceId = personalWorkspaceId
  }
  return sanitized
}

/**
 * Restore a previously-exported envelope into the local DB.
 *
 * Semantics:
 * - **Upsert.** Each row is written by checking for an existing PK row, then
 *   either `UPDATE` (imported file wins) or `INSERT`. Local rows whose PK is
 *   *not* in the file are left untouched. We deliberately avoid Drizzle's
 *   `onConflictDoUpdate`: PowerSync presents synced tables as SQLite views,
 *   and SQLite forbids `INSERT ... ON CONFLICT DO UPDATE` on a view ("cannot
 *   UPSERT a view"). The SELECT + UPDATE/INSERT split works on both real
 *   tables and PowerSync views.
 * - **User-id columns re-stamped.** Every column whose SQL name matches
 *   `user_id` / `*_user_id` (e.g. `user_id`, `owner_user_id`,
 *   `invited_by_user_id`) is overwritten with `currentUser.id`; the value in
 *   the file is never trusted. Tables without any user-id column (e.g. the
 *   secret tables) are unaffected.
 * - **`workspaceId` back-filled.** Rows from a pre-workspaces-v1 backup
 *   arrive without `workspaceId`; on tables that have a `workspace_id`
 *   column, the missing value is stamped with `currentUser.personalWorkspaceId`
 *   so the data lands in the user's personal workspace instead of orphaned at
 *   NULL. Rows that arrive *with* a `workspaceId` are preserved verbatim —
 *   modern multi-workspace backups keep their workspace structure on restore.
 * - **`workspace_memberships` synthesized, not imported.** The envelope
 *   doesn't carry membership rows (see {@link excludedFromExport} —
 *   blindly carrying co-members' rows would either leak their
 *   `userName`/`userEmail` or produce duplicate self-rows on cross-account
 *   import). Instead, after every workspace row is upserted, this importer
 *   synthesizes one admin membership row for the importing user per
 *   imported workspace they don't already belong to locally. PowerSync
 *   reconciles with the BE on next sync.
 * - **`workspace_pending_memberships` ignored.** Admin-only invite metadata
 *   for other people; the BE is authoritative. Rows arriving in the file
 *   (e.g. legacy or hand-crafted) are silently routed to
 *   {@link ImportResult.ignoredTableNames}.
 * - **Foreign personal workspaces merged into the local personal.** Each
 *   user gets exactly one `isPersonal: 1` workspace (BE enforces this via
 *   a partial unique index). A cross-account import would otherwise leave
 *   two personals owned by the importing user. We skip the foreign personal
 *   from the workspaces upsert and rewrite every per-workspace data row
 *   that referenced it to `currentUser.personalWorkspaceId` — the source
 *   user's chats / models / tasks land in the importing user's existing
 *   personal workspace, where they're immediately visible.
 * - **Soft-deleted rows preserved.** `deletedAt` is written verbatim, so a
 *   row exported in the trash stays in the trash after import.
 * - **Atomic.** Wrapped in a single `db.transaction`; any per-row failure
 *   rolls back every preceding write in this call.
 * - **Forward-compatible.** Table keys the importer doesn't recognize (e.g.
 *   tables added in a future schemaVersion) are surfaced in
 *   `ignoredTableNames` but otherwise ignored.
 *
 * Throws {@link ImportFormatError} for envelope problems (wrong format,
 * unsupported schemaVersion, missing `tables`, missing/non-string primary
 * key on a row). Any other thrown error propagates as-is after rollback.
 */
export const importUserData = async (
  db: AnyDrizzleDatabase,
  payload: unknown,
  currentUser: { id: string; personalWorkspaceId: string },
): Promise<ImportResult> => {
  if (!isRecord(payload)) {
    throw new ImportFormatError('Import file is not a JSON object.')
  }
  if (payload.format !== exportFormat) {
    throw new ImportFormatError(
      `Import file is not a Thunderbolt export (expected format "${exportFormat}", got "${String(payload.format)}").`,
    )
  }
  if (payload.schemaVersion !== exportSchemaVersion) {
    throw new ImportFormatError(
      `Unsupported export schemaVersion ${String(payload.schemaVersion)}. This app reads version ${exportSchemaVersion}.`,
    )
  }
  if (!isRecord(payload.tables)) {
    throw new ImportFormatError('Import file is missing the `tables` object.')
  }

  const fileTables = payload.tables
  const ignoredTableNames: string[] = []
  const tableCounts: Partial<Record<IncludedTableName, { upserted: number }>> = {}
  // Workspace ids upserted from the envelope. After the file loop we walk
  // this set and synthesize an admin membership row for the importing user
  // on every workspace they don't already belong to locally — see the doc
  // comment on `importUserData` and `excludedFromExport` in ./export.ts.
  const importedWorkspaceIds = new Set<string>()

  // Pre-pass: build a remap from foreign personal-workspace ids → the
  // importing user's local personal workspace. Re-stamping a foreign
  // `isPersonal: 1` row's ownerUserId to the importing user would leave
  // two personal workspaces with the same owner — non-deterministic local
  // lookup + a guaranteed BE conflict (the `idx_workspaces_personal_per_owner`
  // partial unique index is one-personal-per-owner). Instead, we skip the
  // foreign row from the workspaces upsert entirely and re-attribute every
  // per-workspace data row that pointed at it to the local personal.
  const personalRemap = new Map<string, string>()
  const fileWorkspaces = fileTables.workspaces
  if (Array.isArray(fileWorkspaces)) {
    for (const row of fileWorkspaces) {
      if (
        isRecord(row) &&
        row.isPersonal === 1 &&
        typeof row.id === 'string' &&
        row.id !== currentUser.personalWorkspaceId
      ) {
        personalRemap.set(row.id, currentUser.personalWorkspaceId)
      }
    }
  }

  await db.transaction(async (tx) => {
    for (const [tableName, rows] of Object.entries(fileTables)) {
      if (!isIncludedTableName(tableName)) {
        ignoredTableNames.push(tableName)
        continue
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        continue
      }

      const table = includedTables[tableName]
      const { pk, userIdFields, hasWorkspaceId } = tableImportSpecs[tableName]
      const { column: pkColumn, field: pkField } = pk
      let upsertedCount = 0

      for (const row of rows) {
        if (!isRecord(row)) {
          throw new ImportFormatError(`Row in table "${tableName}" is not an object.`)
        }
        const pkValue = row[pkField]
        if (typeof pkValue !== 'string') {
          throw new ImportFormatError(`Row in "${tableName}" is missing string primary key "${pkField}".`)
        }
        // Foreign personal workspaces don't land as separate rows — their
        // resources are merged into the importing user's personal workspace
        // (see `personalRemap` above).
        if (tableName === 'workspaces' && personalRemap.has(pkValue)) {
          continue
        }
        const sanitized = sanitizeRowForImport(
          row,
          userIdFields,
          hasWorkspaceId,
          currentUser.id,
          currentUser.personalWorkspaceId,
        )
        // Re-attribute any reference to a foreign personal workspace.
        if (hasWorkspaceId && typeof sanitized.workspaceId === 'string') {
          const remapped = personalRemap.get(sanitized.workspaceId)
          if (remapped) {
            sanitized.workspaceId = remapped
          }
        }
        const existing = await tx.select({ pk: pkColumn }).from(table).where(eq(pkColumn, pkValue)).get()
        if (existing) {
          await tx.update(table).set(sanitized).where(eq(pkColumn, pkValue))
        } else {
          await tx.insert(table).values(sanitized)
        }
        upsertedCount += 1
        if (tableName === 'workspaces') {
          importedWorkspaceIds.add(pkValue)
        }
      }

      if (upsertedCount > 0) {
        tableCounts[tableName] = { upserted: upsertedCount }
      }
    }

    // Synthesize membership rows so the importing user can access every
    // imported workspace immediately. Skip workspaces they're already a
    // member of locally (re-import, or a pre-existing membership from
    // PowerSync down-sync). Role is `admin` — consistent with
    // `ownerUserId` being re-stamped to the importing user; the BE
    // reconciles on next sync if the upload disagrees with the truth.
    if (importedWorkspaceIds.size > 0) {
      const existingMemberships = await tx
        .select({ workspaceId: workspaceMembershipsTable.workspaceId })
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.userId, currentUser.id))
      const alreadyMember = new Set(
        existingMemberships.map((m) => m.workspaceId).filter((id): id is string => id !== null),
      )

      for (const workspaceId of importedWorkspaceIds) {
        if (alreadyMember.has(workspaceId)) {
          continue
        }
        await tx.insert(workspaceMembershipsTable).values({
          id: uuidv7(),
          workspaceId,
          userId: currentUser.id,
          role: 'admin',
        })
      }
    }
  })

  return {
    schemaVersion: exportSchemaVersion,
    tables: tableCounts,
    ignoredTableNames,
  }
}
