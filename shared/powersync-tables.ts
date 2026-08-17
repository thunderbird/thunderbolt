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
  'projects',
] as const

export type PowerSyncTableName = (typeof powersyncTableNames)[number]

/**
 * Tables dropped from the synced schema. The backend accepts and ignores
 * upload ops for these (see applyOperation) so a device with a queued legacy
 * write — from before the table was removed — drains its CRUD queue instead
 * of looping on a 400. Never re-add these to powersyncTableNames. See THU-739.
 */
export const legacyPowerSyncTableNames = [
  'modes',
  // `project_files` never reached production — its migration was removed before
  // merge — but devices that ran the Projects branch locally or in a preview env
  // can still hold queued writes for it, and an unknown table is a 400 the client
  // retries forever. Accepting and ignoring lets those queues drain.
  'project_files',
] as const

/**
 * Intended map of PowerSync table names to the React Query keys to invalidate
 * when the table changes. Keys are type-checked against powersyncTableNames, so
 * every table must have an entry, and prefix keys (e.g. ['settings']) would
 * invalidate every query under that prefix.
 *
 * **Nothing reads this map.** It has had no consumer since THU-249 — updates
 * arrive through PowerSync's own reactivity, and a `useQuery` on a watched table
 * re-runs without being invalidated. The entries below are therefore a
 * declaration of intent, not a wiring: adding one has no runtime effect. Kept
 * (rather than deleted) because the sync docs still ask for it and it is the
 * obvious place to hang invalidation if a non-reactive consumer ever needs it.
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
  // Would cover the chat sidebar grouping as well as the project list, if the
  // map above were ever wired up.
  projects: [['projects'], ['chatThreads']],
}
