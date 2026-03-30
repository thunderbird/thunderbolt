/**
 * Single source of truth for PowerSync-synced table names and React Query invalidation.
 * Used by backend (validTables), frontend (use-powersync-invalidation), and sync rules (config.yaml).
 * When adding a table: add here, then to src/db/tables.ts, backend/src/db/powersync-schema.ts,
 * src/db/powersync/schema.ts, and powersync-service/config/config.yaml.
 *
 * NOTE: mcp_servers and mcp_credentials are local-only tables (not listed here) and are never synced.
 * MCP server configs are device-specific (stdio commands, localhost URLs differ per machine).
 * Credentials are stored device-locally via AES-GCM encryption.
 */

export const powersyncTableNames = [
  'settings',
  'chat_threads',
  'chat_messages',
  'tasks',
  'models',
  'prompts',
  'triggers',
  'modes',
  'model_profiles',
  'devices',
] as const

export type PowerSyncTableName = (typeof powersyncTableNames)[number]

/**
 * Map of PowerSync table names to React Query keys to invalidate when the table changes.
 * Keys are type-checked against powersyncTableNames; every table must have an entry.
 * Prefix keys (e.g. ['settings']) invalidate all queries starting with that prefix.
 */
export const powersyncTableToQueryKeys: {
  [K in PowerSyncTableName]: string[][]
} = {
  settings: [['settings']],
  chat_threads: [['chatThreads']],
  chat_messages: [['messages'], ['messageCache']],
  tasks: [['tasks']],
  models: [['models']],
  prompts: [['prompts']],
  triggers: [['triggers']],
  modes: [['modes']],
  model_profiles: [['modelProfiles']],
  devices: [['devices']],
}
