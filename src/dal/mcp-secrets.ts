/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, exists, isNotNull, isNull, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { mcpSecretsTable, mcpServersTable } from '../db/tables'
import { isSameCredentialDestination } from '../lib/credential-destination'
import type { DrizzleQueryWithPromise } from '@/types'

export type McpCredentialSummary = {
  id: string
  type: 'bearer' | 'oauth'
  bearerToken?: string
}

type McpCredentialSummaryRow = {
  id: string
  type: string | null
  bearerToken: string | null
  approvedUrl: string | null
  serverUrl: string | null
}

/**
 * Query credential summaries for all local MCP credentials. The projection
 * happens in SQL so full OAuth token blobs never leave the DAL — these rows
 * end up in the UI layer's query cache.
 */
export const getMcpServerCredentialRows = (db: AnyDrizzleDatabase) => {
  const query = db
    .select({
      id: mcpSecretsTable.id,
      type: sql<string | null>`json_extract(${mcpSecretsTable.credentials}, '$.type')`,
      bearerToken: sql<
        string | null
      >`CASE WHEN json_extract(${mcpSecretsTable.credentials}, '$.type') = 'bearer' THEN json_extract(${mcpSecretsTable.credentials}, '$.token') END`,
      approvedUrl: sql<string | null>`json_extract(${mcpSecretsTable.credentials}, '$.approvedUrl')`,
      serverUrl: mcpServersTable.url,
    })
    .from(mcpSecretsTable)
    .leftJoin(mcpServersTable, eq(mcpServersTable.id, mcpSecretsTable.id))
  return query as typeof query & DrizzleQueryWithPromise<McpCredentialSummaryRow>
}

/**
 * Narrows a projected credential row to the tagged summary shape. Drops
 * malformed rows and credentials saved for another URL than the server's
 * current one, so the UI never offers them for a probe.
 */
export const parseMcpCredentialSummary = (row: McpCredentialSummaryRow): McpCredentialSummary | null => {
  if (!isSameCredentialDestination(row.approvedUrl, row.serverUrl)) {
    return null
  }
  if (row.type === 'bearer') {
    return { id: row.id, type: 'bearer', bearerToken: row.bearerToken ?? undefined }
  }
  return row.type === 'oauth' ? { id: row.id, type: 'oauth' } : null
}

/**
 * Credential blob stored on-device for an MCP server. Forward-supports OAuth
 * token sets. `approvedUrl` is the server URL the credential was saved or
 * authorized for, and the only place it is sent. A blob without it (saved by
 * an older version) is sent nowhere until {@link bindUnboundMcpCredentials} runs.
 */
export type McpServerCredentials = (
  | { type: 'bearer'; token: string }
  | {
      type: 'oauth'
      access_token: string
      refresh_token?: string
      expires_at?: number // epoch ms
      clientId?: string // DCR-issued client_id (per-AS); absent for CIMD
      issuer?: string // AS issuer (per-AS binding)
      tokenEndpoint?: string // discovered token endpoint (for refresh)
      scope?: string
    }
) & { approvedUrl?: string }

export type McpCredentialSnapshot = { serialized: string; credentials: McpServerCredentials }

/** Read parsed credentials with their exact stored representation for a later conditional replacement. */
export const getMcpServerCredentialSnapshot = async (
  db: AnyDrizzleDatabase,
  id: string,
): Promise<McpCredentialSnapshot | null> => {
  const row = await db.select().from(mcpSecretsTable).where(eq(mcpSecretsTable.id, id)).get()

  if (!row?.credentials) {
    return null
  }

  return { serialized: row.credentials, credentials: JSON.parse(row.credentials) as McpServerCredentials }
}

/** Get credentials for an MCP server. Returns null when no row exists. */
export const getMcpServerCredentials = async (
  db: AnyDrizzleDatabase,
  id: string,
): Promise<McpServerCredentials | null> => (await getMcpServerCredentialSnapshot(db, id))?.credentials ?? null

/** Replace only the captured credential on an active, unchanged endpoint; cancellation rolls back the write. */
export const updateMcpServerCredentialsIfCurrent = async (
  db: AnyDrizzleDatabase,
  id: string,
  credentials: McpServerCredentials,
  {
    expectedCredentials,
    expectedUrl,
    signal,
  }: {
    expectedCredentials: string
    expectedUrl: string | null
    signal: AbortSignal
  },
): Promise<void> => {
  await db.transaction(async (tx) => {
    signal.throwIfAborted()
    const activeServer = tx
      .select({ id: mcpServersTable.id })
      .from(mcpServersTable)
      .where(
        and(
          eq(mcpServersTable.id, id),
          eq(mcpServersTable.enabled, 1),
          isNull(mcpServersTable.deletedAt),
          expectedUrl === null ? isNull(mcpServersTable.url) : eq(mcpServersTable.url, expectedUrl),
        ),
      )
    const updated = await tx
      .update(mcpSecretsTable)
      .set({ credentials: JSON.stringify(credentials) })
      .where(
        and(eq(mcpSecretsTable.id, id), eq(mcpSecretsTable.credentials, expectedCredentials), exists(activeServer)),
      )
      .returning({ id: mcpSecretsTable.id })
    signal.throwIfAborted()
    if (!updated.length) {
      throw new Error('MCP connection changed during token refresh')
    }
  })
}

/** The stored credential snapshot for a server, only when it was saved for `url`: a credential never follows a server to another destination. */
export const getMcpServerCredentialSnapshotFor = async (
  db: AnyDrizzleDatabase,
  id: string,
  url: string,
): Promise<McpCredentialSnapshot | null> => {
  const snapshot = await getMcpServerCredentialSnapshot(db, id)
  return isSameCredentialDestination(snapshot?.credentials.approvedUrl, url) ? snapshot : null
}

/** The stored credential for a server, only when it was saved for `url`. */
export const getMcpServerCredentialsFor = async (
  db: AnyDrizzleDatabase,
  id: string,
  url: string,
): Promise<McpServerCredentials | null> => (await getMcpServerCredentialSnapshotFor(db, id, url))?.credentials ?? null

/**
 * Save credentials for an MCP server (insert or update).
 * Uses SELECT-then-INSERT-or-UPDATE because PowerSync local-only tables are views that don't support UPSERT.
 */
export const setMcpServerCredentials = async (
  db: AnyDrizzleDatabase,
  id: string,
  credentials: McpServerCredentials,
): Promise<void> => {
  const json = JSON.stringify(credentials)
  const existing = await db.select().from(mcpSecretsTable).where(eq(mcpSecretsTable.id, id)).get()

  if (existing) {
    await db.update(mcpSecretsTable).set({ credentials: json }).where(eq(mcpSecretsTable.id, id))
  } else {
    await db.insert(mcpSecretsTable).values({ id, credentials: json })
  }
}

/** Delete credentials for an MCP server. */
export const deleteMcpServerCredentials = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  await db.delete(mcpSecretsTable).where(eq(mcpSecretsTable.id, id))
}

/**
 * Binds credentials that have no destination yet (saved by an older version, or
 * restored from an older backup) to their server's current URL. A credential
 * without a live server has nothing to bind to and is dropped, so it can never
 * attach to a server added later under its id.
 */
export const bindUnboundMcpCredentials = async (db: AnyDrizzleDatabase): Promise<void> => {
  const rows = await db
    .select({ id: mcpSecretsTable.id, url: mcpServersTable.url })
    .from(mcpSecretsTable)
    .leftJoin(mcpServersTable, and(eq(mcpServersTable.id, mcpSecretsTable.id), isNull(mcpServersTable.deletedAt)))
    .where(
      and(
        isNotNull(mcpSecretsTable.credentials),
        sql`json_extract(${mcpSecretsTable.credentials}, '$.approvedUrl') IS NULL`,
      ),
    )
  for (const { id, url } of rows) {
    if (url === null) {
      await deleteMcpServerCredentials(db, id)
    } else {
      await db
        .update(mcpSecretsTable)
        .set({ credentials: sql`json_set(${mcpSecretsTable.credentials}, '$.approvedUrl', ${url})` })
        .where(eq(mcpSecretsTable.id, id))
    }
  }
}
