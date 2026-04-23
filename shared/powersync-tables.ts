/**
 * Single source of truth for PowerSync-synced table names and React Query invalidation.
 * Used by backend (validTables), frontend (use-powersync-invalidation), and sync rules (config.yaml).
 * When adding a table: add here, then to src/db/tables.ts, backend/src/db/powersync-schema.ts,
 * src/db/powersync/schema.ts, and powersync-service/config/config.yaml.
 */

// NOTE: Adding a new table here requires the corresponding entry in the
// frontend drizzleSchema (src/db/powersync/schema.ts) and tables definition
// (src/db/tables.ts) at compile time because the `satisfies` constraint
// below references the frontend schema type. This means the two-PR deploy
// pattern (backend migration first, then frontend) must still be followed
// at the DEPLOYMENT level (run migration → update PowerSync Cloud rules →
// deploy frontend), but the frontend schema files themselves must be
// co-located in the backend PR to keep the type system honest.

export const powersyncTableNames = [
  'settings',
  'chat_threads',
  'chat_messages',
  'tasks',
  'models',
  'mcp_servers',
  'prompts',
  'triggers',
  'modes',
  'model_profiles',
  'devices',
  'agents',
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
  mcp_servers: [['mcp-servers']],
  prompts: [['prompts']],
  triggers: [['triggers']],
  modes: [['modes']],
  model_profiles: [['modelProfiles']],
  devices: [['devices']],
  agents: [['agents']],
}
