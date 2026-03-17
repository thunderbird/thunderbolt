import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { mcpServersTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
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
 * Gets all MCP servers of any transport type (excluding soft-deleted).
 * Prefer this over getHttpMcpServers for features that support all transports.
 */
export const getMcpServers = (db: AnyDrizzleDatabase) => {
  const query = db.select().from(mcpServersTable).where(isNull(mcpServersTable.deletedAt))
  return query as typeof query & DrizzleQueryWithPromise<McpServer>
}

/**
 * Gets all HTTP MCP servers with non-null URLs from the database (excluding soft-deleted)
 */
export const getHttpMcpServers = (db: AnyDrizzleDatabase) => {
  const query = db
    .select()
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.type, 'http'), isNotNull(mcpServersTable.url), isNull(mcpServersTable.deletedAt)))
  return query as typeof query & DrizzleQueryWithPromise<McpServer>
}

/**
 * Soft deletes an MCP server by ID (sets deletedAt datetime)
 * Scrubs all non-enum data for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteMcpServer = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  await db
    .update(mcpServersTable)
    .set({ ...clearNullableColumns(mcpServersTable), deletedAt: nowIso() })
    .where(and(eq(mcpServersTable.id, id), isNull(mcpServersTable.deletedAt)))
}

/**
 * Creates a new MCP server with full transport and auth configuration
 */
export const createMcpServer = async (
  db: AnyDrizzleDatabase,
  server: {
    id: string
    name: string
    type?: 'http' | 'stdio' | 'sse'
    url?: string
    command?: string
    args?: string
    authType?: 'none' | 'bearer' | 'oauth'
    encryptedCredential?: string
    oauthAccountId?: string
    enabled?: number
  },
): Promise<void> => {
  await db.insert(mcpServersTable).values(server)
}

/**
 * Updates the auth configuration on an existing MCP server.
 * Only updates auth-related fields; does not touch transport config.
 */
export const updateMcpServerAuth = async (
  db: AnyDrizzleDatabase,
  serverId: string,
  auth: {
    authType: 'none' | 'bearer' | 'oauth'
    encryptedCredential?: string
    oauthAccountId?: string
  },
): Promise<void> => {
  await db
    .update(mcpServersTable)
    .set({
      authType: auth.authType as McpServer['authType'],
      encryptedCredential: auth.encryptedCredential ?? null,
      oauthAccountId: auth.oauthAccountId ?? null,
    })
    .where(and(eq(mcpServersTable.id, serverId), isNull(mcpServersTable.deletedAt)))
}
