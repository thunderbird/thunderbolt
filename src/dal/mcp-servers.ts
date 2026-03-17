import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { mcpServersTable } from '../db/tables'
import { getShadowTable, decryptedJoin, decryptedSelectFor } from '../db/encryption'
import { clearNullableColumns, nowIso } from '../lib/utils'
import { type McpServer } from '@/types'
import type { DrizzleQueryWithPromise } from '@/types'

const mcpShadow = getShadowTable('mcp_servers')
const mcpSelect = decryptedSelectFor('mcp_servers')

/**
 * Gets all MCP servers from the database (excluding soft-deleted)
 */
export const getAllMcpServers = (db: AnyDrizzleDatabase) => {
  const query = db
    .select(mcpSelect)
    .from(mcpServersTable)
    .leftJoin(mcpShadow, decryptedJoin(mcpServersTable, mcpShadow))
    .where(isNull(mcpServersTable.deletedAt))
  return query as typeof query & DrizzleQueryWithPromise<McpServer>
}

/**
 * Gets all HTTP MCP servers with non-null URLs from the database (excluding soft-deleted)
 */
export const getHttpMcpServers = (db: AnyDrizzleDatabase) => {
  const query = db
    .select(mcpSelect)
    .from(mcpServersTable)
    .leftJoin(mcpShadow, decryptedJoin(mcpServersTable, mcpShadow))
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
 * Creates a new MCP server
 */
export const createMcpServer = async (
  db: AnyDrizzleDatabase,
  data: Partial<McpServer> & Pick<McpServer, 'id' | 'name'>,
): Promise<void> => {
  await db.insert(mcpServersTable).values(data)
}
