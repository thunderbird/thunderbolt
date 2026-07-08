/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { mcpSecretsTable, mcpServersTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import { deleteMcpServerCredentials, setMcpServerCredentials, type McpServerCredentials } from './mcp-secrets'
import { type McpServer } from '@/types'
import type { DrizzleQueryWithPromise } from '@/types'

/**
 * Gets all MCP servers from the database (excluding soft-deleted)
 */
export const getAllMcpServers = (db: AnyDrizzleDatabase) => {
  const query = db.select().from(mcpServersTable).where(isNull(mcpServersTable.deletedAt))
  return query as typeof query & DrizzleQueryWithPromise<McpServer>
}

/**
 * Gets all remote (HTTP / SSE) MCP servers with non-null URLs from the database (excluding soft-deleted).
 * Local (stdio) servers are excluded — they have no URL and are connected via a different transport.
 */
export const getRemoteMcpServers = (db: AnyDrizzleDatabase) => {
  const query = db
    .select()
    .from(mcpServersTable)
    .where(
      and(
        inArray(mcpServersTable.type, ['http', 'sse']),
        isNotNull(mcpServersTable.url),
        isNull(mcpServersTable.deletedAt),
      ),
    )
  return query as typeof query & DrizzleQueryWithPromise<McpServer>
}

/**
 * Soft deletes an MCP server by ID (sets deletedAt datetime)
 * Scrubs all non-enum data for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteMcpServer = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx.delete(mcpSecretsTable).where(eq(mcpSecretsTable.id, id))
    await tx
      .update(mcpServersTable)
      .set({ ...clearNullableColumns(mcpServersTable), deletedAt: nowIso() })
      .where(and(eq(mcpServersTable.id, id), isNull(mcpServersTable.deletedAt)))
  })
}

/**
 * Creates a new MCP server
 */
export const createMcpServer = async (
  db: AnyDrizzleDatabase,
  data: Partial<McpServer> & Pick<McpServer, 'id' | 'name'>,
): Promise<void> => {
  await db.insert(mcpServersTable).values(data)
}

/**
 * Creates an MCP server together with its optional on-device credentials in a
 * single transaction. `useMcpSync` connects on the new `mcp_servers` row and
 * reads the secret at connect time, so the secret must commit alongside the row
 * — a partial write would orphan the secret or connect unauthenticated.
 * Symmetric to {@link deleteMcpServer}.
 */
export const createMcpServerWithCredentials = async (
  db: AnyDrizzleDatabase,
  data: Partial<McpServer> & Pick<McpServer, 'id' | 'name'>,
  credentials?: McpServerCredentials,
): Promise<void> => {
  await db.transaction(async (tx) => {
    if (credentials) {
      await setMcpServerCredentials(tx, data.id, credentials)
    }
    await createMcpServer(tx, data)
  })
}

/**
 * Patches an MCP server row (and bumps updatedAt). The patch must NOT include
 * `id` or `createdAt`; touch only mutable columns. No-op when the id doesn't
 * match (the update silently affects zero rows).
 */
export const updateMcpServer = async (
  db: AnyDrizzleDatabase,
  id: string,
  patch: Partial<Omit<McpServer, 'id' | 'createdAt'>>,
): Promise<void> => {
  await db
    .update(mcpServersTable)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(mcpServersTable.id, id))
}

/**
 * Updates an MCP server row and (optionally) its on-device credentials in a
 * single transaction. Symmetric to {@link createMcpServerWithCredentials}.
 * `credentials` semantics:
 *   - `undefined`: leave existing credential alone (e.g. rename without touching the token)
 *   - `null`: delete existing credential (user cleared the bearer field)
 *   - object: replace existing credential
 */
export const updateMcpServerWithCredentials = async (
  db: AnyDrizzleDatabase,
  id: string,
  patch: Partial<Omit<McpServer, 'id' | 'createdAt'>>,
  credentials?: McpServerCredentials | null,
): Promise<void> => {
  await db.transaction(async (tx) => {
    if (credentials === null) {
      await deleteMcpServerCredentials(tx, id)
    } else if (credentials) {
      await setMcpServerCredentials(tx, id, credentials)
    }
    await updateMcpServer(tx, id, patch)
  })
}

/** One server row plus its optional on-device credential, for batch creation. */
export type McpServerWithCredential = {
  server: Partial<McpServer> & Pick<McpServer, 'id' | 'name'>
  credential?: McpServerCredentials
}

/**
 * Creates many MCP servers and their optional credentials in a SINGLE
 * transaction, so a JSON import is atomic on the write side — matching the
 * parser's all-or-nothing contract. A failure on any item rolls back every row
 * and secret. Batches the writes inline (not via
 * {@link createMcpServerWithCredentials}, which opens its own transaction).
 */
export const createMcpServersWithCredentials = async (
  db: AnyDrizzleDatabase,
  items: McpServerWithCredential[],
): Promise<void> => {
  await db.transaction(async (tx) => {
    for (const { server, credential } of items) {
      // Credential before the row (matching createMcpServerWithCredentials) so the
      // ordering is consistent and a future non-transactional refactor stays safe.
      if (credential) {
        await setMcpServerCredentials(tx, server.id, credential)
      }
      await createMcpServer(tx, server)
    }
  })
}
