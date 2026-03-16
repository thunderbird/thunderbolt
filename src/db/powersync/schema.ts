import type { PowerSyncTableName } from '@shared/powersync-tables'
import type { DrizzleTableWithPowerSyncOptions } from '@powersync/drizzle-driver'
import { DrizzleAppSchema } from '@powersync/drizzle-driver'
import * as tables from '../tables'

/**
 * Drizzle schema for PowerSync - keys are snake_case (table names).
 * Synced tables are type-checked against PowerSyncTableName.
 * Local-only tables (e.g. tasks_decrypted) use DrizzleTableWithPowerSyncOptions.
 */
const syncedSchema = {
  settings: tables.settingsTable,
  chat_threads: tables.chatThreadsTable,
  chat_messages: tables.chatMessagesTable,
  tasks: tables.tasksTable,
  models: tables.modelsTable,
  mcp_servers: tables.mcpServersTable,
  prompts: tables.promptsTable,
  triggers: tables.triggersTable,
  modes: tables.modesTable,
  model_profiles: tables.modelProfilesTable,
  devices: tables.devicesTable,
} satisfies Record<PowerSyncTableName, unknown>

export const drizzleSchema = {
  ...syncedSchema,
  tasks_decrypted: {
    tableDefinition: tables.tasksDecryptedTable,
    options: { localOnly: true },
  } satisfies DrizzleTableWithPowerSyncOptions,
}

/**
 * PowerSync AppSchema derived from Drizzle table definitions.
 */
export const AppSchema = new DrizzleAppSchema(drizzleSchema)
