import { DrizzleAppSchema } from '@powersync/drizzle-driver'
import * as tables from '../tables'

/**
 * Drizzle schema for PowerSync - uses existing table definitions.
 * This maps directly to the Drizzle tables for seamless integration.
 */
export const drizzleSchema = {
  settings: tables.settingsTable,
  chatThreads: tables.chatThreadsTable,
  chatMessages: tables.chatMessagesTable,
  tasks: tables.tasksTable,
  models: tables.modelsTable,
  mcpServers: tables.mcpServersTable,
  prompts: tables.promptsTable,
  triggers: tables.triggersTable,
}

/**
 * PowerSync AppSchema derived from Drizzle table definitions.
 * This automatically creates the PowerSync schema from Drizzle.
 */
export const AppSchema = new DrizzleAppSchema(drizzleSchema)
