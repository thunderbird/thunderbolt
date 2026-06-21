/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { mcpSecretsTable, mcpServersTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import { setMcpServerCredentials, type McpServerCredentials } from './mcp-secrets'
import { type McpServer } from '@/types'
import type { DrizzleQueryWithPromise } from '@/types'

/**
 * Gets all MCP servers in the given workspace (excluding soft-deleted)
 */
export const getAllMcpServers = (db: AnyDrizzleDatabase, workspaceId: string) => {
  const query = db
    .select()
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.workspaceId, workspaceId), isNull(mcpServersTable.deletedAt)))
  return query as typeof query & DrizzleQueryWithPromise<McpServer>
}

/**
 * Gets all remote (HTTP / SSE) MCP servers in the given workspace with non-null URLs (excluding soft-deleted).
 * Local (stdio) servers are excluded — they have no URL and are connected via a different transport.
 */
export const getRemoteMcpServers = (db: AnyDrizzleDatabase, workspaceId: string) => {
  const query = db
    .select()
    .from(mcpServersTable)
    .where(
      and(
        eq(mcpServersTable.workspaceId, workspaceId),
        inArray(mcpServersTable.type, ['http', 'sse']),
        isNotNull(mcpServersTable.url),
        isNull(mcpServersTable.deletedAt),
      ),
    )
  return query as typeof query & DrizzleQueryWithPromise<McpServer>
}

/**
 * Update an MCP server in the given workspace. Strips `workspaceId` from the
 * payload so callers can't reassign a row across workspaces — the row stays
 * in the workspace it was filtered to.
 */
export const updateMcpServer = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  id: string,
  updates: Partial<McpServer>,
): Promise<void> => {
  const { workspaceId: _workspaceId, ...updateFields } = updates
  await db
    .update(mcpServersTable)
    .set(updateFields)
    .where(and(eq(mcpServersTable.id, id), eq(mcpServersTable.workspaceId, workspaceId)))
}

/**
 * Soft deletes an MCP server in the given workspace by ID (sets deletedAt datetime).
 * Scrubs all non-enum data for privacy. Only updates records that haven't been
 * deleted yet to preserve original deletion datetimes.
 */
export const deleteMcpServer = async (db: AnyDrizzleDatabase, workspaceId: string, id: string): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx.delete(mcpSecretsTable).where(eq(mcpSecretsTable.id, id))
    await tx
      .update(mcpServersTable)
      .set({ ...clearNullableColumns(mcpServersTable), deletedAt: nowIso() })
      .where(
        and(eq(mcpServersTable.id, id), eq(mcpServersTable.workspaceId, workspaceId), isNull(mcpServersTable.deletedAt)),
      )
  })
}

/**
 * Creates a new MCP server in the given workspace. Defaults `scope` to
 * `'workspace'`; pass `scope: 'user'` (with a matching `userId`) to make the
 * row private to its author (THU-603).
 */
export const createMcpServer = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  data: Partial<McpServer> & Pick<McpServer, 'id' | 'name'>,
): Promise<void> => {
  await db.insert(mcpServersTable).values({ ...data, workspaceId, scope: data.scope ?? 'workspace' })
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
  workspaceId: string,
  data: Partial<McpServer> & Pick<McpServer, 'id' | 'name'>,
  credentials?: McpServerCredentials,
): Promise<void> => {
  await db.transaction(async (tx) => {
    if (credentials) {
      await setMcpServerCredentials(tx, data.id, credentials)
    }
    await createMcpServer(tx, workspaceId, data)
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
  workspaceId: string,
  items: McpServerWithCredential[],
): Promise<void> => {
  await db.transaction(async (tx) => {
    for (const { server, credential } of items) {
      if (credential) {
        await setMcpServerCredentials(tx, server.id, credential)
      }
      await createMcpServer(tx, workspaceId, server)
    }
  })
}
