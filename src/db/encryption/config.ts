import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core'
import {
  chatMessagesTable,
  chatThreadsTable,
  devicesTable,
  mcpServersTable,
  modelProfilesTable,
  modelsTable,
  modesTable,
  promptsTable,
  settingsTable,
  tasksTable,
  triggersTable,
} from '../tables'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySQLiteTable = SQLiteTableWithColumns<any>

type EncryptedTableConfig<T extends AnySQLiteTable> = {
  table: T
  columns: readonly (keyof T['$inferSelect'] & string)[]
}

/** Type-safe helper — validates column names against the table's schema at compile time. */
const defineEncrypted = <T extends AnySQLiteTable>(config: EncryptedTableConfig<T>): EncryptedTableConfig<T> => config

/**
 * Single source of truth for all encrypted tables and their columns.
 * Adding a new entry here automatically generates:
 * - Shadow table (local-only, stores decoded values)
 * - Trigger-based decryption watcher
 * - CRUD upload encoding
 * - PowerSync schema registration
 */
export const encryptionConfig = {
  settings: defineEncrypted({ table: settingsTable, columns: ['value'] }),
  chat_threads: defineEncrypted({ table: chatThreadsTable, columns: ['title'] }),
  chat_messages: defineEncrypted({
    table: chatMessagesTable,
    columns: ['content', 'parts', 'cache', 'metadata'],
  }),
  tasks: defineEncrypted({ table: tasksTable, columns: ['item'] }),
  models: defineEncrypted({ table: modelsTable, columns: ['name', 'model', 'url', 'apiKey', 'vendor', 'description'] }),
  mcp_servers: defineEncrypted({ table: mcpServersTable, columns: ['name', 'url', 'command', 'args'] }),
  prompts: defineEncrypted({ table: promptsTable, columns: ['title', 'prompt'] }),
  triggers: defineEncrypted({ table: triggersTable, columns: ['triggerTime'] }),
  model_profiles: defineEncrypted({
    table: modelProfilesTable,
    columns: [
      'toolsOverride',
      'linkPreviewsOverride',
      'chatModeAddendum',
      'searchModeAddendum',
      'researchModeAddendum',
      'citationReinforcementPrompt',
      'nudgeFinalStep',
      'nudgePreventive',
      'nudgeRetry',
      'nudgeSearchFinalStep',
      'nudgeSearchPreventive',
      'nudgeSearchRetry',
      'providerOptions',
    ],
  }),
  modes: defineEncrypted({ table: modesTable, columns: ['name', 'label', 'icon', 'systemPrompt'] }),
  devices: defineEncrypted({ table: devicesTable, columns: ['name'] }),
} as const

export type EncryptionConfig = typeof encryptionConfig
export type EncryptedTableName = keyof EncryptionConfig
