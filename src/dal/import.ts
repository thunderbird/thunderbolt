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
 * - **`workspace_permissions` dropped for remapped workspaces.** When
 *   multiple foreign workspaces collapse to local personal (cross-account
 *   import), keeping their permission rows would produce duplicates on
 *   `(workspace_id, permission_key)` — locally permitted by the non-unique
 *   index but rejected on BE upload (BE has a unique index). The BE
 *   applies the admin-only default (Decision 11) when a key has no row, so
 *   dropping is harmless. Same-account import (no remap) preserves the
 *   rows.
 * - **Fresh ids minted for id-only-conflict tables on cross-account
 *   import.** `chat_threads`, `chat_messages`, and `triggers` use `(id)`
 *   alone as the BE conflict target (other per-workspace tables use
 *   composite `(id, workspace_id)`). Re-uploading a source row's id under
 *   the importing user's workspace silently no-ops on the BE (`ON CONFLICT
 *   (id) DO UPDATE WHERE workspace_id = …` doesn't match the existing
 *   row's `workspace_id`), and the down-sync then wipes the local rows.
 *   The import mints a fresh `uuidv7()` per row and rewires every cross-
 *   reference that points at one: `chat_messages.chatThreadId` /
 *   `chat_messages.parentId` to the new chat ids, `chat_threads.triggeredBy`
 *   to the new trigger id. Same-account re-import doesn't mint — the
 *   existing BE row's `workspace_id` already matches the upload, so the
 *   upsert updates in place.
 * - **Foreign personal workspaces merge into local personal; foreign
 *   shared workspaces are preserved under fresh ids (cross-account).** Each
 *   user gets exactly one personal workspace on the BE (partial unique
 *   index `(ownerUserId, isPersonal=true)`), so an imported personal
 *   collapses into `currentUser.personalWorkspaceId` — every per-workspace
 *   row referencing it is rewritten. Foreign shared workspaces in
 *   cross-account mode (`payload.user.id !== currentUser.id`) are kept
 *   but inserted under a freshly-minted `uuidv7()`; the source's id would
 *   collide with the existing BE row and the upsert would silently no-op,
 *   then `workspace_essentials` down-sync (gated on membership) would wipe
 *   the local row. `slug` is stripped on insert (BE has a global unique
 *   index on `slug`). The synthesized admin membership added after the
 *   file loop lets `isSharedWorkspaceAdminBootstrap` accept the first
 *   write on the BE. Same-account import preserves shared workspaces
 *   under their original ids — they already exist on the BE with this
 *   user as admin, so upserts no-op in place.
 * - **`workspace_permissions` follow the workspace remap.** Rows whose
 *   source workspace collapses into local personal are dropped: N foreign
 *   workspaces' policies sharing one `workspace_id` would all collide on
 *   the BE's unique `(workspace_id, permission_key)` index, and the BE
 *   applies the admin-only default (Decision 11) when a key has no row.
 *   Rows for preserved foreign-shared workspaces are kept under a fresh
 *   `uuidv7()` id (the BE conflict target on this table is `[id]` alone,
 *   so re-using the source's id would silently no-op against its existing
 *   BE row).
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

  // Build a remap from foreign workspace ids → their local target. Three
  // cases drive entries here, all because the BE won't accept uploads
  // referencing workspaces the importing user isn't a member of on the
  // server (the workspace handler short-circuits on `isWorkspaceAdmin` /
  // `isWorkspaceMember` and the upserts silently no-op or permanent-reject;
  // the next down-sync then wipes the orphaned local rows).
  //
  // 1. Foreign personal (`isPersonal: 1`, `id !== currentUser.personalWorkspaceId`):
  //    collapse into local personal. Each user gets exactly one personal
  //    workspace (BE partial unique index on `(ownerUserId, isPersonal=true)`),
  //    so we never insert a second one. The remap target is the importing
  //    user's existing personal id; per-workspace data is rewritten to it.
  // 2. Foreign shared, cross-account (`isPersonal: 0` AND
  //    `payload.user.id !== currentUser.id`): mint a fresh `uuidv7()` so
  //    the workspace lands on the BE as a brand-new row (no `(id)` PK
  //    conflict against the source's row). The importing user authors it
  //    locally; `isSharedWorkspaceAdminBootstrap` on the BE accepts the
  //    synthesized admin membership the importer adds after the file loop.
  //    `slug` is stripped at insert time — the BE has a global unique index
  //    on `slug` and we don't want to collide with the source's row.
  // 3. Same-account shared: no remap. Source ids already exist on the BE
  //    with this user as admin; upload upserts are in-place no-ops and
  //    everything round-trips.
  const sourceUserId = isRecord(payload.user) && typeof payload.user.id === 'string' ? payload.user.id : null
  const isCrossAccount = sourceUserId === null || sourceUserId !== currentUser.id
  const workspaceRemap = new Map<string, string>()
  const fileWorkspaces = fileTables.workspaces
  if (Array.isArray(fileWorkspaces)) {
    for (const row of fileWorkspaces) {
      if (!isRecord(row) || typeof row.id !== 'string') {
        continue
      }
      if (row.id === currentUser.personalWorkspaceId) {
        continue
      }
      if (row.isPersonal === 1) {
        workspaceRemap.set(row.id, currentUser.personalWorkspaceId)
      } else if (isCrossAccount) {
        workspaceRemap.set(row.id, uuidv7())
      }
    }
  }

  // Cross-account permissions for *preserved* foreign-shared workspaces
  // need fresh ids too — BE conflict target on `workspace_permissions` is
  // `[id]` alone (same id-only-collision problem we hit on chat_threads),
  // so re-uploading the source's permission id under the new workspace id
  // would no-op the upsert. Permissions for workspaces that collapse to
  // local personal aren't kept at all (handled in the row loop below).
  const workspacePermissionIdRemap = new Map<string, string>()
  const filePermissions = fileTables.workspace_permissions
  if (Array.isArray(filePermissions)) {
    for (const row of filePermissions) {
      if (!isRecord(row) || typeof row.id !== 'string' || typeof row.workspaceId !== 'string') {
        continue
      }
      const remapped = workspaceRemap.get(row.workspaceId)
      if (remapped && remapped !== currentUser.personalWorkspaceId) {
        workspacePermissionIdRemap.set(row.id, uuidv7())
      }
    }
  }

  // Cross-account: mint fresh ids for `chat_threads` and `chat_messages`.
  // The BE's `INSERT ... ON CONFLICT (id) DO UPDATE WHERE workspace_id = ...`
  // on these two tables uses `id` alone as the conflict target (the other
  // workspace-scoped tables use composite `(id, workspace_id)`). Re-uploading
  // the source's row id under the importing user's workspace silently no-ops:
  // the conflict fires on the source's existing BE row but the setWhere
  // clause doesn't match its `workspace_id`, so nothing is written. PowerSync
  // acks the upload as success, then the `user_private` down-sync (filtered
  // by `user_id = caller`) returns nothing and removes the local rows. Fresh
  // ids sidestep the collision entirely. Same-account re-import is fine —
  // the existing BE row's `workspace_id` matches, the upsert updates in place.
  const chatThreadIdRemap = new Map<string, string>()
  const chatMessageIdRemap = new Map<string, string>()
  const triggerIdRemap = new Map<string, string>()
  if (isCrossAccount) {
    const fileChatThreads = fileTables.chat_threads
    if (Array.isArray(fileChatThreads)) {
      for (const row of fileChatThreads) {
        if (isRecord(row) && typeof row.id === 'string') {
          chatThreadIdRemap.set(row.id, uuidv7())
        }
      }
    }
    const fileChatMessages = fileTables.chat_messages
    if (Array.isArray(fileChatMessages)) {
      for (const row of fileChatMessages) {
        if (isRecord(row) && typeof row.id === 'string') {
          chatMessageIdRemap.set(row.id, uuidv7())
        }
      }
    }
    // Triggers share the same id-only BE conflict target as chat_threads /
    // chat_messages — re-uploading the source's id would silently no-op.
    // `chat_threads.triggeredBy` references trigger ids, so the remap is
    // also applied when chat_threads rows are written below.
    const fileTriggers = fileTables.triggers
    if (Array.isArray(fileTriggers)) {
      for (const row of fileTriggers) {
        if (isRecord(row) && typeof row.id === 'string') {
          triggerIdRemap.set(row.id, uuidv7())
        }
      }
    }
  }

  await db.transaction(async (tx) => {
    const processTable = async (tableName: IncludedTableName, rows: unknown[]): Promise<void> => {
      const table = includedTables[tableName]
      const { pk, userIdFields, hasWorkspaceId } = tableImportSpecs[tableName]
      const { column: pkColumn, field: pkField } = pk
      let upsertedCount = 0

      for (const row of rows) {
        if (!isRecord(row)) {
          throw new ImportFormatError(`Row in table "${tableName}" is not an object.`)
        }
        const filePkValue = row[pkField]
        if (typeof filePkValue !== 'string') {
          throw new ImportFormatError(`Row in "${tableName}" is missing string primary key "${pkField}".`)
        }
        // Foreign workspaces that merged into local personal don't land as
        // separate rows; foreign-shared workspaces (cross-account) DO land,
        // but under the freshly-minted id from `workspaceRemap`.
        if (tableName === 'workspaces') {
          const target = workspaceRemap.get(filePkValue)
          if (target === currentUser.personalWorkspaceId) {
            continue
          }
        }
        // Workspace policy rows for workspaces that collapse to local personal
        // are dropped: collapsing N foreign workspaces would otherwise produce
        // N rows sharing `(workspace_id, permission_key)`, which the BE
        // rejects on upload (unique index `idx_workspace_permissions_workspace_key`).
        // The BE applies Decision-11 admin-default when no row is present.
        // Rows for preserved foreign-shared workspaces are kept and follow
        // the new workspace id via the per-workspace remap below.
        if (tableName === 'workspace_permissions') {
          const rowWorkspaceId = row.workspaceId
          if (
            typeof rowWorkspaceId === 'string' &&
            workspaceRemap.get(rowWorkspaceId) === currentUser.personalWorkspaceId
          ) {
            continue
          }
        }
        const sanitized = sanitizeRowForImport(
          row,
          userIdFields,
          hasWorkspaceId,
          currentUser.id,
          currentUser.personalWorkspaceId,
        )
        // Re-attribute any reference to a remapped foreign workspace.
        if (hasWorkspaceId && typeof sanitized.workspaceId === 'string') {
          const remapped = workspaceRemap.get(sanitized.workspaceId)
          if (remapped) {
            sanitized.workspaceId = remapped
          }
        }
        // Cross-account id remap for chat_threads / chat_messages — see the
        // doc on `chatThreadIdRemap` for why this is required.
        let pkValue = filePkValue
        if (tableName === 'chat_threads') {
          const newId = chatThreadIdRemap.get(filePkValue)
          if (newId) {
            pkValue = newId
            sanitized.id = newId
          }
          // `triggeredBy` references a trigger row's id; remap to the new
          // id minted in the triggers pre-pass.
          if (typeof sanitized.triggeredBy === 'string') {
            const remappedTrigger = triggerIdRemap.get(sanitized.triggeredBy)
            if (remappedTrigger) {
              sanitized.triggeredBy = remappedTrigger
            }
          }
        } else if (tableName === 'triggers') {
          const newId = triggerIdRemap.get(filePkValue)
          if (newId) {
            pkValue = newId
            sanitized.id = newId
          }
        } else if (tableName === 'chat_messages') {
          const newId = chatMessageIdRemap.get(filePkValue)
          if (newId) {
            pkValue = newId
            sanitized.id = newId
          }
          if (typeof sanitized.chatThreadId === 'string') {
            const remappedThread = chatThreadIdRemap.get(sanitized.chatThreadId)
            if (remappedThread) {
              sanitized.chatThreadId = remappedThread
            }
          }
          if (typeof sanitized.parentId === 'string') {
            const remappedParent = chatMessageIdRemap.get(sanitized.parentId)
            if (remappedParent) {
              sanitized.parentId = remappedParent
            }
          }
        } else if (tableName === 'workspaces') {
          // Preserved foreign-shared workspace: insert under the freshly-
          // minted id from `workspaceRemap`, slug stripped (the BE has a
          // global unique index on `slug`).
          const newId = workspaceRemap.get(filePkValue)
          if (newId) {
            pkValue = newId
            sanitized.id = newId
            sanitized.slug = null
          }
        } else if (tableName === 'workspace_permissions') {
          // Preserved foreign-shared permissions: mint a fresh id so the
          // BE's id-only `ON CONFLICT` doesn't silently no-op against the
          // source's existing row.
          const newId = workspacePermissionIdRemap.get(filePkValue)
          if (newId) {
            pkValue = newId
            sanitized.id = newId
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

    // CRUD-queue order matters for PowerSync: a foreign-shared workspace
    // lands on the BE as a brand-new row, so its synthesized admin
    // membership must precede any per-workspace upload (chat_threads etc.
    // are validated by `isWorkspaceMember`, which the BE evaluates against
    // the cumulative state of earlier ops in the same batch). Our own
    // export emits `workspaces` LAST in the envelope; processing in the
    // file's own order would queue chat_messages → ... → workspaces →
    // memberships and the BE would reject mid-batch. So:
    //   1. `workspaces` first (insert new rows, skip merged personals)
    //   2. synthesize memberships for any imported workspace the user
    //      doesn't already belong to locally
    //   3. everything else (per-workspace data, settings, secrets, …)
    if (Array.isArray(fileTables.workspaces) && fileTables.workspaces.length > 0) {
      await processTable('workspaces', fileTables.workspaces)
    }

    // Synthesize membership rows so the importing user can access every
    // imported workspace immediately. Skip workspaces they're already a
    // member of locally (re-import, or a pre-existing membership from
    // PowerSync down-sync). Role is `admin` — consistent with the
    // `ownerUserId` re-stamp and with the importing user being the only
    // local actor; on cross-account, foreign-shared workspaces have zero
    // BE members and `isSharedWorkspaceAdminBootstrap` accepts the row.
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

    for (const [tableName, rows] of Object.entries(fileTables)) {
      if (tableName === 'workspaces') {
        continue
      }
      if (!isIncludedTableName(tableName)) {
        ignoredTableNames.push(tableName)
        continue
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        continue
      }
      await processTable(tableName, rows)
    }
  })

  return {
    schemaVersion: exportSchemaVersion,
    tables: tableCounts,
    ignoredTableNames,
  }
}
