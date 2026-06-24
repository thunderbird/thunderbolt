/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { localOnlyTables, syncedTables } from '@/db/powersync/schema'
import { workspaceMembershipsTable } from '@/db/tables'
import { and, eq } from 'drizzle-orm'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'

export const exportFormat = 'thunderbolt-export'
export const exportSchemaVersion = 1

/** Every table name PowerSync knows about — synced and local-only. */
type AllTableName = keyof typeof syncedTables | keyof typeof localOnlyTables

/**
 * Tables intentionally excluded from the user-data export:
 * - `devices`: per-device trust state, meaningless on the importing device.
 * - `integrations_secrets`: third-party OAuth tokens (Google / Microsoft).
 *   The importing user re-authenticates instead.
 * - `agents_system`: backend-hydrated catalog, not user content.
 * - `workspace_memberships` / `workspace_pending_memberships`: BE-authoritative
 *   membership graph. The local DB carries every member's row for every
 *   workspace the user belongs to (sync rule isn't filtered by `user_id`),
 *   so blindly carrying them through would either leak co-members'
 *   names/emails into the backup or — on cross-account import — collapse
 *   them into duplicate self-rows. PowerSync repopulates on first sync; on
 *   import we synthesize a single admin row for the importing user per
 *   imported workspace so the UI works offline (see `importUserData`).
 *
 * Typed against {@link AllTableName} so a future schema rename/removal trips
 * the compiler. Anything not in this list is included.
 */
const excludedFromExport = [
  'devices',
  'integrations_secrets',
  'agents_system',
  'workspace_memberships',
  'workspace_pending_memberships',
] as const satisfies readonly AllTableName[]
type ExcludedTableName = (typeof excludedFromExport)[number]
export type IncludedTableName = Exclude<AllTableName, ExcludedTableName>

const isExcluded = (name: string): name is ExcludedTableName => (excludedFromExport as readonly string[]).includes(name)

/**
 * Flat name → Drizzle table map for every table the export walks. Built from
 * the same source of truth PowerSync uses, so adding a new table in
 * `src/db/powersync/schema.ts` automatically picks it up here — it'll appear
 * in exports unless added to {@link excludedFromExport}.
 *
 * Exported so the importer ({@link src/dal/import.ts}) can iterate the same
 * set without redefining it.
 */
export const includedTables = Object.fromEntries(
  Object.entries({
    ...syncedTables,
    ...Object.fromEntries(Object.entries(localOnlyTables).map(([name, def]) => [name, def.tableDefinition])),
  }).filter(([name]) => !isExcluded(name)),
  // `Object.fromEntries` returns `{ [k: string]: SQLiteTable }`, which TS won't directly cast to
  // `Record<IncludedTableName, SQLiteTable>` (finite key union — TS can't prove each named key is
  // present from a string-indexed source). Hence the `unknown` hop, per TS's own recovery hint.
) as unknown as Record<IncludedTableName, SQLiteTable>

/**
 * Backup envelope produced by {@link exportUserData}. See
 * `docs/architecture/export-format.md` for the spec consumed by THU-597.
 *
 * `tables` is keyed by the precise included-table union (auto-derived from
 * the PowerSync schema minus {@link excludedFromExport}), so the importer
 * gets type-safe access to known buckets. Row shapes are intentionally
 * `unknown[]` — the envelope stays decoupled from future column additions.
 */
export type UserDataExport = {
  format: typeof exportFormat
  schemaVersion: typeof exportSchemaVersion
  exportedAt: string
  user: { id: string; email: string | null }
  tables: Record<IncludedTableName, unknown[]>
}

/**
 * Names of the tables included in the export envelope. Frozen at module
 * load so callers can iterate without risking accidental mutation.
 */
export const exportedTableNames: readonly IncludedTableName[] = Object.freeze(
  Object.keys(includedTables) as IncludedTableName[],
)

/**
 * Returns a structural snapshot of every row in the local DB that a user
 * would expect in a backup: synced user content + user-typed credentials.
 * Soft-deleted rows are included — restore logic decides what to do with
 * them.
 *
 * Three cross-cutting filters apply, all driven by the set of workspaces
 * the user has an `admin` membership for:
 * - `workspace_memberships` and `workspace_pending_memberships` are dropped
 *   entirely (BE-authoritative; co-member leakage). See
 *   {@link excludedFromExport}.
 * - `workspaces` is filtered to rows in the admin set. Personal workspaces
 *   (seeded with an admin membership at bootstrap) and shared workspaces
 *   the user created or was promoted to admin in are included; shared
 *   workspaces the user joined as a member are dropped — they're BE-managed
 *   and re-sync on first login. (The schema deliberately reserves
 *   `workspaces.owner_user_id` for the personal-workspace anchor — it is
 *   **not** an access-control role — which is why admin membership, not
 *   ownership, is the right signal.)
 * - Every per-workspace data table (any synced table with a `workspace_id`
 *   column — chat threads, models, prompts, …) is filtered to rows whose
 *   `workspaceId` is in the admin set. Rows with `workspaceId = NULL` are
 *   kept — those are pre-v1 leftovers that the importer back-fills to the
 *   importing user's personal workspace. Without this filter the backup
 *   would carry stranded rows referencing workspaces the importer can't
 *   reach until PowerSync re-syncs.
 *
 * `attributedTo` is stamped into the envelope's `user` field as metadata,
 * and drives the workspaces filter above.
 */
export const exportUserData = async (
  db: AnyDrizzleDatabase,
  attributedTo: { id: string; email: string | null },
): Promise<UserDataExport> => {
  const adminWorkspaceRows = await db
    .select({ workspaceId: workspaceMembershipsTable.workspaceId })
    .from(workspaceMembershipsTable)
    .where(and(eq(workspaceMembershipsTable.userId, attributedTo.id), eq(workspaceMembershipsTable.role, 'admin')))
  const adminWorkspaceIds = new Set(
    adminWorkspaceRows.map((row) => row.workspaceId).filter((id): id is string => id !== null),
  )

  const entries = Object.entries(includedTables) as Array<[IncludedTableName, SQLiteTable]>
  const results = await Promise.all(
    entries.map(async ([name, table]) => {
      const rows = await db.select().from(table)
      if (name === 'workspaces') {
        const adminOnly = rows.filter((row) => adminWorkspaceIds.has((row as { id: string }).id))
        return [name, adminOnly] as const
      }
      const hasWorkspaceId = getTableConfig(table).columns.some((c) => c.name === 'workspace_id')
      if (hasWorkspaceId) {
        const adminScoped = rows.filter((row) => {
          const wsId = (row as { workspaceId?: string | null }).workspaceId
          // Pre-v1 rows have no workspaceId yet — keep them so the importer's
          // back-fill can attach them to the importing user's personal.
          return wsId === null || wsId === undefined || adminWorkspaceIds.has(wsId)
        })
        return [name, adminScoped] as const
      }
      return [name, rows] as const
    }),
  )

  return {
    format: exportFormat,
    schemaVersion: exportSchemaVersion,
    exportedAt: new Date().toISOString(),
    user: { id: attributedTo.id, email: attributedTo.email },
    tables: Object.fromEntries(results) as Record<IncludedTableName, unknown[]>,
  }
}
