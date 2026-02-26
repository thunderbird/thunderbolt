import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { mcpServersTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import { type McpServer } from '@/types'

/**
 * Gets all MCP servers from the database (excluding soft-deleted)
 */
export const getAllMcpServers = async (): Promise<McpServer[]> => {
  const db = DatabaseSingleton.instance.db
  return (await db.select().from(mcpServersTable).where(isNull(mcpServersTable.deletedAt))) as McpServer[]
}

/**
 * Gets all HTTP MCP servers with non-null URLs from the database (excluding soft-deleted)
 */
export const getHttpMcpServers = async (): Promise<McpServer[]> => {
  const db = DatabaseSingleton.instance.db
  return (await db
    .select()
    .from(mcpServersTable)
    .where(
      and(eq(mcpServersTable.type, 'http'), isNotNull(mcpServersTable.url), isNull(mcpServersTable.deletedAt)),
    )) as McpServer[]
}

/**
 * Soft deletes an MCP server by ID (sets deletedAt datetime)
 * Scrubs all non-enum data for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteMcpServer = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db
    .update(mcpServersTable)
    .set({ ...clearNullableColumns(mcpServersTable), deletedAt: nowIso() })
    .where(and(eq(mcpServersTable.id, id), isNull(mcpServersTable.deletedAt)))
}

/**
 * Creates a new MCP server
 */
export const createMcpServer = async (data: Partial<McpServer> & Pick<McpServer, 'id' | 'name'>): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.insert(mcpServersTable).values(data)
}
