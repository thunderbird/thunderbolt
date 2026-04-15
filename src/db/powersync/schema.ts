import type { PowerSyncTableName } from '@shared/powersync-tables'
import { DrizzleAppSchema, type DrizzleTableWithPowerSyncOptions } from '@powersync/drizzle-driver'
import * as tables from '../tables'

/**
 * Drizzle schema for PowerSync - keys are snake_case (table names).
 * Type-checked: every PowerSyncTableName must have an entry.
 * The driver uses the table's config name, not our keys; snake_case keeps types in sync with shared.
 */
export const drizzleSchema = {
  settings: tables.settingsTable,
  chat_threads: tables.chatThreadsTable,
  chat_messages: tables.chatMessagesTable,
  tasks: tables.tasksTable,
  models: tables.modelsTable,
  prompts: tables.promptsTable,
  triggers: tables.triggersTable,
  modes: tables.modesTable,
  model_profiles: tables.modelProfilesTable,
  devices: tables.devicesTable,
} satisfies Record<PowerSyncTableName, unknown>

/** Local-only tables — not in PowerSyncTableName, never synced */
const mcpServersLocalOnly: DrizzleTableWithPowerSyncOptions = {
  tableDefinition: tables.mcpServersTable,
  options: { localOnly: true },
}
const mcpCredentialsLocalOnly: DrizzleTableWithPowerSyncOptions = {
  tableDefinition: tables.mcpCredentialsTable,
  options: { localOnly: true },
}

/**
 * PowerSync AppSchema derived from Drizzle table definitions.
 */
export const AppSchema = new DrizzleAppSchema({
  ...drizzleSchema,
  mcp_servers: mcpServersLocalOnly,
  mcp_credentials: mcpCredentialsLocalOnly,
})
