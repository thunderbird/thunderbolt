import { and, eq, isNotNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { mcpServersTable } from '../db/tables'
import { type McpServer } from '@/types'

/**
 * Gets all MCP servers from the database
 */
export const getAllMcpServers = async (): Promise<McpServer[]> => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(mcpServersTable)
}

/**
 * Gets all HTTP MCP servers with non-null URLs from the database
 */
export const getHttpMcpServers = async (): Promise<McpServer[]> => {
  const db = DatabaseSingleton.instance.db
  return await db
    .select()
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.type, 'http'), isNotNull(mcpServersTable.url)))
}

/**
 * Deletes an MCP server by ID
 */
export const deleteMcpServer = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.delete(mcpServersTable).where(eq(mcpServersTable.id, id))
}
