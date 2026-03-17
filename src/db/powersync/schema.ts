import type { PowerSyncTableName } from '@shared/powersync-tables'
import type { DrizzleTableWithPowerSyncOptions } from '@powersync/drizzle-driver'
import { DrizzleAppSchema } from '@powersync/drizzle-driver'
import * as tables from '../tables'
import { shadowTables, shadowTableName } from '../encryption'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { encryptionConfig } from '../encryption'

/**
 * Drizzle schema for PowerSync - keys are snake_case (table names).
 * Synced tables are type-checked against PowerSyncTableName.
 * Shadow tables for encryption are auto-registered as localOnly.
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

/** Auto-register all encryption shadow tables as localOnly */
const localOnlySchema = Object.fromEntries(
  Object.entries(encryptionConfig).map(([key, config]) => [
    shadowTableName(getTableConfig(config.table).name),
    {
      tableDefinition: shadowTables[key as keyof typeof shadowTables],
      options: { localOnly: true },
    } satisfies DrizzleTableWithPowerSyncOptions,
  ]),
)

export const drizzleSchema = {
  ...syncedSchema,
  ...localOnlySchema,
}

/**
 * PowerSync AppSchema derived from Drizzle table definitions.
 */
export const AppSchema = new DrizzleAppSchema(drizzleSchema)
