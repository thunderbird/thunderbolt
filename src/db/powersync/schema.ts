/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PowerSyncTableName } from '@shared/powersync-tables'
import { DrizzleAppSchema, type DrizzleTableWithPowerSyncOptions } from '@powersync/drizzle-driver'
import * as tables from '../tables'

/**
 * Synced tables — type-checked against PowerSyncTableName.
 * Keys are snake_case (table names). The driver uses the table's config name, not our keys.
 */
const syncedTables = {
  settings: tables.settingsTable,
  chat_threads: tables.chatThreadsTable,
  chat_messages: tables.chatMessagesTable,
  tasks: tables.tasksTable,
  models: tables.modelsTable,
  mcp_servers: tables.mcpServersTable,
  prompts: tables.promptsTable,
  skills: tables.skillsTable,
  triggers: tables.triggersTable,
  modes: tables.modesTable,
  model_profiles: tables.modelProfilesTable,
  devices: tables.devicesTable,
} satisfies Record<PowerSyncTableName, unknown>

/** Local-only tables — created in SQLite but never synced via PowerSync. */
const localOnlyTables = {
  models_secrets: {
    tableDefinition: tables.modelsSecretsTable,
    options: { localOnly: true },
  } satisfies DrizzleTableWithPowerSyncOptions,
  integrations_secrets: {
    tableDefinition: tables.integrationsSecretsTable,
    options: { localOnly: true },
  } satisfies DrizzleTableWithPowerSyncOptions,
}

/**
 * Combined Drizzle schema for PowerSync AppSchema.
 */
export const drizzleSchema = {
  ...syncedTables,
  ...localOnlyTables,
}

/**
 * PowerSync AppSchema derived from Drizzle table definitions.
 */
export const AppSchema = new DrizzleAppSchema(drizzleSchema)
