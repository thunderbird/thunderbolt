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
 * Scrubbed data for soft-deleted MCP servers.
 * Clears nullable columns to null, required text to '', required integers to default.
 * Keeps type (enum) unchanged.
 */
const scrubbedMcpServerData = {
  name: '',
  url: null,
  command: null,
  args: null,
  enabled: 0,
  createdAt: null,
  updatedAt: null,
}

/**
 * Soft deletes an MCP server by ID (sets deletedAt timestamp)
 * Scrubs all non-enum data for privacy
 */
export const deleteMcpServer = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db
    .update(mcpServersTable)
    .set({ ...scrubbedMcpServerData, deletedAt: Date.now() })
    .where(eq(mcpServersTable.id, id))
}

/**
 * Creates a new MCP server
 */
export const createMcpServer = async (data: Partial<McpServer> & Pick<McpServer, 'id' | 'name'>): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.insert(mcpServersTable).values(data)
}
