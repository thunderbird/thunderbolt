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
import { bindCredentialDestinations } from './credential-destinations'
import { chatTablesOf, detectChatImport, rekeyChat, type ChatFileSummary } from './chat-import'
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

/**
 * Local-only credential tables. A file row replaces the local row outright, so
 * a partial row can never keep a local key while rewriting where it is bound.
 */
const secretTableNames: ReadonlySet<string> = new Set(['models_secrets', 'mcp_secrets', 'agents_secrets'])

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
   * `true` when both `sourceEmail` and the importing user's email are present
   * and differ (case-insensitively). The UI uses this to flag a cross-account
   * import in the confirm dialog. Stays `false` when either side is missing
   * — better to under-warn than to false-positive on legacy exports.
   */
  accountMismatch: boolean
  /** The chat the file holds when it holds exactly one, so the dialog can say so. Null for a full backup. */
  chat: ChatFileImport | null
}

/** An account as an export names it or a session knows it; signed out, both are null. */
type AccountIdentity = { id: string | null; email: string | null }

/** The importing user, plus this device's id, which keys a chat copied in while signed out. */
type ImportingUser = AccountIdentity & { deviceId: string }

/** A single-chat file, and whether importing it adds a copy under new ids rather than updating the chat in place. */
type ChatFileImport = ChatFileSummary & { isCopy: boolean }

const emailsMatch = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The exporting account named in a file's `user`, with missing and empty values as null. */
const sourceIdentity = (exportedBy: unknown): AccountIdentity => {
  const nonEmpty = (value: unknown) => (typeof value === 'string' && value ? value : null)
  return isRecord(exportedBy)
    ? { id: nonEmpty(exportedBy.id), email: nonEmpty(exportedBy.email) }
    : { id: null, email: null }
}

/**
 * Whether the file came from the importing account. Emails decide when both sides have one, as for
 * `accountMismatch`: an account deleted and recreated gets a new id, but its old rows went with the deletion, so their
 * ids are free again. Otherwise only equal, non-empty user ids match. A signed-out side never matches, because rows
 * made while signed out are uploaded by whichever account signs in first, and their ids may already be owned.
 *
 * The file states its own exporter, so this is a claim, not proof. A forged claim only keeps the file's own ids.
 */
const isSameAccount = (exportedBy: unknown, currentUser: AccountIdentity): boolean => {
  const source = sourceIdentity(exportedBy)
  if (source.email && currentUser.email) {
    return emailsMatch(source.email, currentUser.email)
  }
  return source.id !== null && source.id === currentUser.id
}

/** The single chat a file holds, if it holds one, and whether it imports as a copy. Shared by preview and import. */
const chatFileImport = (payload: Record<string, unknown>, currentUser: AccountIdentity): ChatFileImport | null => {
  const chat = isRecord(payload.tables) ? detectChatImport(payload.tables, payload.kind) : null
  return chat && { ...chat, isCopy: !isSameAccount(payload.user, currentUser) }
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
 * Pass `currentUser` to enable cross-account detection. `accountMismatch`
 * is set when the envelope's email and the session email both exist and
 * differ; email (not `user.id`) is its comparison field, because better-auth
 * assigns a new id when an account is deleted and recreated, but the same
 * human's email stays stable. `chat` describes a single-chat file; its
 * `isCopy` follows {@link isSameAccount}, which falls back to user ids.
 */
export const summarizeExportEnvelope = (
  payload: unknown,
  currentUser: AccountIdentity = { id: null, email: null },
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
  const { email: sourceEmail } = sourceIdentity(payload.user)
  const accountMismatch =
    sourceEmail !== null && currentUser.email !== null && !emailsMatch(sourceEmail, currentUser.email)
  return { totalRows, exportedAtLabel, sourceEmail, accountMismatch, chat: chatFileImport(payload, currentUser) }
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
  currentUserId: string | null,
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
 *   is never trusted. A signed-out import uses `null`, preserving local
 *   ownership. Tables without `user_id` (the secret tables) are unaffected.
 * - **Soft-deleted rows preserved.** `deletedAt` is written verbatim, so a
 *   row exported in the trash stays in the trash after import.
 * - **Secrets stay bound to their destination.** A secret row in the file
 *   replaces the local one outright instead of merging. A local secret the file
 *   omits stays bound to the URL it was saved for, so a parent row the file
 *   points elsewhere no longer reads it.
 * - **Atomic.** Wrapped in a single `db.transaction`; any per-row failure
 *   rolls back every preceding write in this call.
 * - **A single-chat file writes only the chat.** Its other tables are listed in `ignoredTableNames`, so a file shown
 *   as "one chat" can't change settings, models or servers. If {@link isSameAccount} doesn't tie it to the importing
 *   account, the chat gets ids of its own (see {@link rekeyChat}), keyed by the user, or by the device when signed
 *   out, because the backend would drop rows whose ids another account owns. Re-importing under the same key updates
 *   the copy.
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
  currentUser: ImportingUser,
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

  const chat = chatFileImport(payload, currentUser)
  // The prefix keeps a device key from ever equalling a user id.
  const ownerKey = currentUser.id ?? `device:${currentUser.deviceId}`
  const fileTables = !chat
    ? payload.tables
    : chat.isCopy
      ? rekeyChat(payload.tables, ownerKey)
      : chatTablesOf(payload.tables)
  const ignoredTableNames: string[] = chat
    ? Object.entries(payload.tables)
        .filter(([name, rows]) => !(name in fileTables) && Array.isArray(rows) && rows.length > 0)
        .map(([name]) => name)
    : []
  const tableCounts: Partial<Record<IncludedTableName, { upserted: number }>> = {}

  await db.transaction(async (tx) => {
    // Before the upsert local credentials bind to the URLs they had; after it, rows from an
    // older backup bind to the restored URLs and re-spelled URLs keep their credential.
    await bindCredentialDestinations(tx)
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
      const isSecret = secretTableNames.has(tableName)

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
        if (existing && isSecret) {
          await tx.delete(table).where(eq(pkColumn, pkValue))
        }
        if (existing && !isSecret) {
          await tx.update(table).set(sanitized).where(eq(pkColumn, pkValue))
        } else {
          await tx.insert(table).values(sanitized)
        }
        const count = tableCounts[tableName]?.upserted ?? 0
        tableCounts[tableName] = { upserted: count + 1 }
      }
    }
    await bindCredentialDestinations(tx)
  })

  return {
    schemaVersion: exportSchemaVersion,
    tables: tableCounts,
    ignoredTableNames,
  }
}
