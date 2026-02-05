/**
 * Single source of truth for PowerSync-synced table names and React Query invalidation.
 * Used by backend (VALID_TABLES), frontend (use-powersync-invalidation), and sync rules (config.yaml).
 * When adding a table: add here, then to src/db/tables.ts, backend/src/db/powersync-schema.ts,
 * src/db/powersync/schema.ts, and powersync-service/config/config.yaml.
 */

export const POWERSYNC_TABLE_NAMES = [
  'settings',
  'chat_threads',
  'chat_messages',
  'tasks',
  'models',
  'mcp_servers',
  'prompts',
  'triggers',
  'modes',
  'devices',
] as const

export type PowerSyncTableName = (typeof POWERSYNC_TABLE_NAMES)[number]

/**
 * Map of PowerSync table names to React Query keys to invalidate when the table changes.
 * Keys are type-checked against POWERSYNC_TABLE_NAMES; every table must have an entry.
 * Prefix keys (e.g. ['settings']) invalidate all queries starting with that prefix.
 */
export const POWERSYNC_TABLE_TO_QUERY_KEYS: {
  [K in PowerSyncTableName]: string[][]
} = {
  settings: [['settings']],
  chat_threads: [['chatThreads']],
  chat_messages: [['messages'], ['messageCache']],
  tasks: [['tasks']],
  models: [['models']],
  mcp_servers: [['mcp-servers']],
  prompts: [['prompts']],
  triggers: [['triggers']],
  modes: [['modes']],
  devices: [['devices']],
}
