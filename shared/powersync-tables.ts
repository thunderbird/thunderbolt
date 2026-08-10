/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Single source of truth for PowerSync-synced table names and React Query invalidation.
 * Used by backend (validTables), frontend (use-powersync-invalidation), and sync rules (config.yaml).
 * When adding a table: add here, then to src/db/tables.ts, backend/src/db/powersync-schema.ts,
 * src/db/powersync/schema.ts, and ALL THREE sync-rule configs:
 *   - powersync-service/config/config.yaml   (local docker-compose)
 *   - deploy/config/powersync-config.yaml    (baked into the ghcr image; preview + Render prod)
 *   - deploy/k8s/templates/configmaps.yaml   (Helm-rendered config for enterprise k8s)
 */

export const powersyncTableNames = [
  'settings',
  'chat_threads',
  'chat_messages',
  'tasks',
  'models',
  'prompts',
  'skills',
  'triggers',
  'model_profiles',
  'devices',
  'agents',
] as const

export type PowerSyncTableName = (typeof powersyncTableNames)[number]

/**
 * Tables dropped from the synced schema. The backend accepts and ignores
 * upload ops for these (see applyOperation) so a device with a queued legacy
 * write — from before the table was removed — drains its CRUD queue instead
 * of looping on a 400. Never re-add these to powersyncTableNames. See THU-739.
 */
export const legacyPowerSyncTableNames = ['modes'] as const

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
  skills: [['skills']],
  triggers: [['triggers']],
  model_profiles: [['modelProfiles']],
  devices: [['devices']],
  agents: [['agents']],
}
