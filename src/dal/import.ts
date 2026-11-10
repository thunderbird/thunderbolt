/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getActiveLocale } from '@/i18n/active-locale'
import { getFormatters } from '@/i18n/format'
import { isRecord } from '@/lib/utils'
import { eq } from 'drizzle-orm'
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { exportFormat, exportSchemaVersion, exportedTableNames, includedTables, type IncludedTableName } from './export'
import { providerConnectionsTable } from '@/db/tables'
import { credentialBinding } from '@/providers/credentials'
import { providerTypes } from '@/providers/types'
import { getProviderDefinition } from '@/providers/registry'
import { normalizeProviderConnectionUrl } from './provider-connections'
import { z } from 'zod'

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
  /** True when the table has a `user_id` column (every synced table; secret tables omit it). */
  hasUserId: boolean
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
      hasUserId: getTableConfig(table).columns.some((c) => c.name === 'user_id'),
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

const isIncludedTableName = (name: string): name is IncludedTableName =>
  (exportedTableNames as readonly string[]).includes(name)

const importedProviderConnection = z.object({
  id: z.string().min(1),
  provider: z.enum(providerTypes),
  name: z.string().refine((name) => name.trim().length > 0),
  authMethod: z.enum(['oauth', 'api_key']),
  url: z.string().nullable(),
  enabled: z.union([z.literal(0), z.literal(1)]),
  updatedAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)))
    .nullable()
    .optional(),
})

/** Imported connections must satisfy the same routing policy as newly authorized ones. */
const validateProviderConnectionForImport = (row: Record<string, unknown>): void => {
  const result = importedProviderConnection.safeParse(row)
  if (!result.success) {
    throw new ImportFormatError('Invalid provider connection metadata.')
  }
  const connection = result.data
  if (
    (connection.authMethod === 'oauth' &&
      (!getProviderDefinition(connection.provider).oauth || connection.id !== `oauth:${connection.provider}`)) ||
    (connection.authMethod === 'api_key' && connection.id.startsWith('oauth:'))
  ) {
    throw new ImportFormatError('Invalid provider connection metadata.')
  }
  try {
    if (connection.url !== normalizeProviderConnectionUrl(connection.provider, connection.url)) {
      throw new ImportFormatError('Invalid provider connection metadata.')
    }
  } catch {
    // URL parser errors may contain user-entered credentials.
    throw new ImportFormatError('Invalid provider connection metadata.')
  }
}

/** Restore only explicitly entered API keys; OAuth grants always require sign-in on this device. */
const providerSecretForImport = async (db: AnyDrizzleDatabase, row: Record<string, unknown>, id: string) => {
  const connection = await db.select().from(providerConnectionsTable).where(eq(providerConnectionsTable.id, id)).get()
  if (!connection || connection.authMethod !== 'api_key' || !connection.provider) {
    return null
  }
  const binding = credentialBinding({
    provider: connection.provider,
    authMethod: connection.authMethod,
    url: connection.url,
  })
  const serialized = row.credentials
  if (row.binding !== binding || typeof serialized !== 'string') {
    throw new ImportFormatError('Provider credentials do not match their connection.')
  }
  const credentials: unknown = (() => {
    try {
      return JSON.parse(serialized)
    } catch {
      // JSON syntax errors can include the credential text in their message.
      throw new ImportFormatError('Invalid provider API key backup.')
    }
  })()
  if (!isRecord(credentials) || typeof credentials.apiKey !== 'string') {
    throw new ImportFormatError('Invalid provider API key backup.')
  }
  return {
    id,
    binding,
    credentials: JSON.stringify({ apiKey: credentials.apiKey, sessionRevision: crypto.randomUUID() }),
  }
}

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
          return Number.isNaN(parsed.getTime()) ? null : getFormatters(getActiveLocale()).date(parsed)
        })()
      : null
  const sourceEmail = isRecord(payload.user) && typeof payload.user.email === 'string' ? payload.user.email : null
  const accountMismatch =
    sourceEmail !== null && currentUserEmail !== null && sourceEmail.toLowerCase() !== currentUserEmail.toLowerCase()
  return { totalRows, exportedAtLabel, sourceEmail, accountMismatch }
}

/**
 * Drop the file's `userId` and either re-stamp it from the current session
 * (tables with a `user_id` column) or omit it entirely (secret tables, which
 * have no such column). The file's value is never trusted: backups carry the
 * source user's id, but a tampered or cross-account file would otherwise
 * plant a foreign id in the local DB until backend reconciliation.
 *
 * The backend's PowerSync upload route enforces the same invariant from the
 * JWT (see `backend/src/dal/powersync.ts`).
 */
const sanitizeRowForImport = (
  row: Record<string, unknown>,
  hasUserId: boolean,
  currentUserId: string,
): Record<string, unknown> => {
  const { userId: _ignored, ...rest } = row
  return hasUserId ? { ...rest, userId: currentUserId } : rest
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
 * - **`userId` re-stamped.** Tables with a `user_id` column have their
 *   row's `userId` overwritten with `currentUser.id`; the value in the file
 *   is never trusted. Tables without `user_id` (the secret tables) are
 *   unaffected.
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
  currentUser: { id: string },
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

  await db.transaction(async (tx) => {
    // Metadata must be restored before checking credential bindings, regardless of JSON key order.
    const entries = Object.entries(fileTables).sort(
      ([a], [b]) => Number(b === 'provider_connections') - Number(a === 'provider_connections'),
    )
    for (const [tableName, rows] of entries) {
      if (!isIncludedTableName(tableName)) {
        ignoredTableNames.push(tableName)
        continue
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        continue
      }

      const table = includedTables[tableName]
      const { pk, hasUserId } = tableImportSpecs[tableName]
      const { column: pkColumn, field: pkField } = pk

      for (const row of rows) {
        if (!isRecord(row)) {
          throw new ImportFormatError(`Row in table "${tableName}" is not an object.`)
        }
        const pkValue = row[pkField]
        if (typeof pkValue !== 'string') {
          throw new ImportFormatError(`Row in "${tableName}" is missing string primary key "${pkField}".`)
        }
        if (tableName === 'provider_connections') {
          validateProviderConnectionForImport(row)
        }
        const sanitized =
          tableName === 'provider_connection_secrets'
            ? await providerSecretForImport(tx, row, pkValue)
            : sanitizeRowForImport(row, hasUserId, currentUser.id)
        if (!sanitized) {
          continue
        }
        const existing = await tx.select({ pk: pkColumn }).from(table).where(eq(pkColumn, pkValue)).get()
        if (existing) {
          await tx.update(table).set(sanitized).where(eq(pkColumn, pkValue))
        } else {
          await tx.insert(table).values(sanitized)
        }
        const count = tableCounts[tableName]?.upserted ?? 0
        tableCounts[tableName] = { upserted: count + 1 }
      }
    }
  })

  return {
    schemaVersion: exportSchemaVersion,
    tables: tableCounts,
    ignoredTableNames,
  }
}
