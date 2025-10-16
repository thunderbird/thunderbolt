import { and, eq, isNotNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { mcpServersTable } from '../db/tables'

/**
 * Gets all MCP servers from the database
 */
export const getAllMcpServers = async () => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(mcpServersTable)
}

/**
 * Gets all HTTP MCP servers with non-null URLs from the database
 */
export const getHttpMcpServers = async () => {
  const db = DatabaseSingleton.instance.db
  const allServers = await db
    .select()
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.type, 'http'), isNotNull(mcpServersTable.url)))

  return allServers.map((server) => ({
    id: server.id,
    name: server.name,
    url: server.url as string,
    enabled: server.enabled,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  }))
}
