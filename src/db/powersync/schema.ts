/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PowerSyncTableName } from '@shared/powersync-tables'
import { DrizzleAppSchema } from '@powersync/drizzle-driver'
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
  mcp_servers: tables.mcpServersTable,
  prompts: tables.promptsTable,
  triggers: tables.triggersTable,
  modes: tables.modesTable,
  model_profiles: tables.modelProfilesTable,
  devices: tables.devicesTable,
} satisfies Record<PowerSyncTableName, unknown>

/**
 * PowerSync AppSchema derived from Drizzle table definitions.
 */
export const AppSchema = new DrizzleAppSchema(drizzleSchema)
