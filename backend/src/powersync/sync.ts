import {
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelsTable,
  promptsTable,
  settingsTable,
  tasksTable,
  triggersTable,
} from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'

export type CrudOperation = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  table: string
  id: string
  data?: Record<string, unknown>
}

/**
 * Map of table names to their Drizzle table definitions
 */
const TABLE_MAP = {
  settings: settingsTable,
  chat_threads: chatThreadsTable,
  chat_messages: chatMessagesTable,
  tasks: tasksTable,
  models: modelsTable,
  mcp_servers: mcpServersTable,
  prompts: promptsTable,
  triggers: triggersTable,
} as const

type AllowedTable = keyof typeof TABLE_MAP

const isAllowedTable = (table: string): table is AllowedTable => {
  return table in TABLE_MAP
}

/**
 * Convert snake_case to camelCase.
 * Client sends snake_case (SQLite column names), Drizzle uses camelCase.
 */
const snakeToCamel = (str: string): string => str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())

/**
 * Convert all keys in an object from snake_case to camelCase.
 */
const convertKeysToCamel = (data: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(data).map(([key, value]) => [snakeToCamel(key), value]))

/**
 * Build the values object for a table insert.
 * Converts client snake_case keys to camelCase and adds id/userId.
 */
const buildValues = (id: string, userId: string, data: Record<string, unknown> = {}) => ({
  id,
  userId,
  ...convertKeysToCamel(data),
})

/**
 * Build the set object for a table update (excludes id and userId).
 */
const buildUpdateSet = (data: Record<string, unknown> = {}) => {
  const converted = convertKeysToCamel(data)
  // Filter out undefined values and exclude id/userId
  return Object.fromEntries(
    Object.entries(converted).filter(([key, v]) => v !== undefined && key !== 'id' && key !== 'userId'),
  )
}

/**
 * Apply a CRUD operation from PowerSync to the appropriate table.
 *
 * PowerSync operations:
 * - PUT: Insert or replace (upsert)
 * - PATCH: Update specific fields
 * - DELETE: Soft delete (set deletedAt timestamp)
 */
export const applyOperation = async (database: unknown, userId: string, operation: CrudOperation): Promise<void> => {
  const { op, table: tableName, id, data } = operation
  const db = database as PgDatabase<never, never, never>

  if (!isAllowedTable(tableName)) {
    throw new Error(`Table '${tableName}' is not allowed for sync`)
  }

  const table = TABLE_MAP[tableName]

  switch (op) {
    case 'PUT': {
      const values = buildValues(id, userId, data)
      await db
        .insert(table)
        .values(values as never)
        .onConflictDoUpdate({
          target: table.id,
          set: buildUpdateSet(data) as never,
        })
      break
    }

    case 'PATCH': {
      if (!data || Object.keys(data).length === 0) {
        return
      }
      const updateSet = buildUpdateSet(data)
      if (Object.keys(updateSet).length > 0) {
        await db
          .update(table)
          .set(updateSet as never)
          .where(and(eq(table.id, id), eq((table as typeof settingsTable).userId, userId)))
      }
      break
    }

    case 'DELETE': {
      await db
        .update(table)
        .set({ deletedAt: Math.floor(Date.now() / 1000) } as never)
        .where(and(eq(table.id, id), eq((table as typeof settingsTable).userId, userId)))
      break
    }
  }
}
