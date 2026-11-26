/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { localOnlyTables, syncedTables } from '@/db/powersync/schema'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { and, eq, getTableColumns, isNull } from 'drizzle-orm'
import {
  chatMessagesTable,
  chatThreadsTable,
  providerConnectionsTable,
  providerConnectionSecretsTable,
} from '@/db/tables'
import { providerCredentialBound } from '@/providers/credentials'
import type { ProviderCredentials } from '@/providers/types'

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
 *
 * Typed against {@link AllTableName} so a future schema rename/removal trips
 * the compiler. Anything not in this list is included.
 */
const excludedFromExport = [
  'devices',
  'integrations_secrets',
  'agents_system',
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
 * `docs/internals/architecture/export-format.md` for the spec consumed by THU-597.
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

/** The envelope fields every export starts with. */
const envelopeHeader = (attributedTo: UserDataExport['user']): Omit<UserDataExport, 'tables'> => ({
  format: exportFormat,
  schemaVersion: exportSchemaVersion,
  exportedAt: new Date().toISOString(),
  user: { id: attributedTo.id, email: attributedTo.email },
})

/**
 * Returns a structural snapshot of every row in the local DB that a user
 * would expect in a backup: synced user content + user-typed credentials.
 * Soft-deleted rows are included — restore logic decides what to do with
 * them.
 *
 * No `userId` filter is applied: the local SQLite file already contains
 * exactly one user's data (PowerSync only syncs down rows the JWT is allowed
 * to see, and anonymous / standalone DBs never see other users at all).
 *
 * `attributedTo` is stamped into the envelope's `user` field as metadata —
 * it does not scope the query in any way.
 */
export const exportUserData = async (
  db: AnyDrizzleDatabase,
  attributedTo: UserDataExport['user'],
): Promise<UserDataExport> => {
  const entries = Object.entries(includedTables) as Array<[IncludedTableName, SQLiteTable]>
  const results = await Promise.all(
    entries.map(async ([name, table]) => {
      if (name === 'provider_connection_secrets') {
        const rows = await db
          .select(getTableColumns(providerConnectionSecretsTable))
          .from(providerConnectionSecretsTable)
          .innerJoin(providerConnectionsTable, eq(providerConnectionSecretsTable.id, providerConnectionsTable.id))
          .where(and(eq(providerConnectionsTable.authMethod, 'api_key'), providerCredentialBound))
        // Backups retain user-entered keys. OAuth grants and refresh tokens require a new sign-in.
        return [
          name,
          rows.map((row) => ({
            ...row,
            credentials: JSON.stringify({
              apiKey: (JSON.parse(row.credentials ?? '{}') as ProviderCredentials).apiKey ?? '',
            }),
          })),
        ] as const
      }
      return [name, await db.select().from(table)] as const
    }),
  )

  return {
    ...envelopeHeader(attributedTo),
    tables: Object.fromEntries(results) as Record<IncludedTableName, unknown[]>,
  }
}

/** Marks a file that holds one chat, so the importer knows it even if later formats add tables to it. */
export const chatExportKind = 'chat'

type ExportedChatThreadRow = Omit<typeof chatThreadsTable.$inferSelect, 'userId'>
type ExportedChatMessageRow = Omit<typeof chatMessagesTable.$inferSelect, 'userId'>

/** A {@link UserDataExport} envelope holding one chat: its thread row and that thread's messages. */
export type ChatExport = Omit<UserDataExport, 'tables'> & {
  kind: typeof chatExportKind
  tables: { chat_threads: [ExportedChatThreadRow]; chat_messages: ExportedChatMessageRow[] }
}

/**
 * The scheme and host of an MCP server URL: enough for its icon, without a path, query or credentials. A URL that
 * doesn't parse gives `''`, which drops it rather than risk sharing it; the icon then falls back to the generic one.
 */
const urlOrigin = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** Metadata of messages saved before `mcpTools` existed, which named the servers in `mcpServers`. */
type StoredMessageMetadata = NonNullable<ExportedChatMessageRow['metadata']> & { mcpServers?: unknown }

/**
 * Drops what a shared chat must not carry: the path and query of each MCP server URL a turn used (a hosted server's
 * URL can hold a token), the older `mcpServers` record of those servers, and the debug-capture link. Names and origins
 * stay, so tool calls still render.
 */
const shareableMetadata = (metadata: ExportedChatMessageRow['metadata']): ExportedChatMessageRow['metadata'] => {
  if (!metadata) {
    return metadata
  }
  const {
    debugTranscript: _debugTranscript,
    mcpServers: _legacyMcpServers,
    mcpTools,
    ...rest
  }: StoredMessageMetadata = metadata
  if (!mcpTools) {
    return rest
  }
  return {
    ...rest,
    mcpTools: Object.fromEntries(
      Object.entries(mcpTools).map(([key, tool]) => [key, { ...tool, url: urlOrigin(tool.url) }]),
    ),
  }
}

/**
 * Snapshot of one chat in the backup envelope, for sharing a single conversation: every message the thread holds,
 * edited-away branches included and soft-deleted ones left out, as the chat itself shows them. Rows carry no `userId`, which the importer stamps anyway; the envelope still names
 * the exporter, which the importer needs to tell its own chat from someone else's. Throws when the thread doesn't
 * exist.
 */
export const exportChatThread = async (
  db: AnyDrizzleDatabase,
  threadId: string,
  attributedTo: UserDataExport['user'],
): Promise<ChatExport> => {
  const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId)).get()
  if (!thread) {
    throw new Error(`Chat ${threadId} does not exist.`)
  }
  const messages = await db
    .select()
    .from(chatMessagesTable)
    .where(and(eq(chatMessagesTable.chatThreadId, threadId), isNull(chatMessagesTable.deletedAt)))
  const { userId: _threadOwner, ...threadRow } = thread
  return {
    ...envelopeHeader(attributedTo),
    kind: chatExportKind,
    tables: {
      chat_threads: [threadRow],
      chat_messages: messages.map(({ userId: _messageOwner, metadata, ...message }) => ({
        ...message,
        metadata: shareableMetadata(metadata),
      })),
    },
  }
}
