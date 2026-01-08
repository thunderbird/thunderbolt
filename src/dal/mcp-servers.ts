import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { mcpServersTable } from '../db/tables'
import { type McpServer } from '@/types'

/**
 * Gets all MCP servers from the database (excluding soft-deleted)
 */
export const getAllMcpServers = async (): Promise<McpServer[]> => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(mcpServersTable).where(isNull(mcpServersTable.deletedAt))
}

/**
 * Gets all HTTP MCP servers with non-null URLs from the database (excluding soft-deleted)
 */
export const getHttpMcpServers = async (): Promise<McpServer[]> => {
  const db = DatabaseSingleton.instance.db
  return await db
    .select()
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.type, 'http'), isNotNull(mcpServersTable.url), isNull(mcpServersTable.deletedAt)))
}

/**
 * Soft deletes an MCP server by ID (sets deletedAt timestamp)
 */
export const deleteMcpServer = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.update(mcpServersTable).set({ deletedAt: Date.now() }).where(eq(mcpServersTable.id, id))
}

/**
 * Creates a new MCP server
 */
export const createMcpServer = async (data: Partial<McpServer> & Pick<McpServer, 'id' | 'name'>): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.insert(mcpServersTable).values(data)
}
