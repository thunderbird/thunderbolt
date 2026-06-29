/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * One-shot data migration that lets pre-Workspaces v1 users open the new build
 * without losing local state. The orchestrator wires three steps:
 *
 *   1. localStorage   — namespace the un-prefixed auth token + device id keys
 *      per `serverId` so the new build still finds the user signed in.
 *   2. IndexedDB      — copy `thunderbolt-keys` to `thunderbolt-keys__<serverId>`
 *      so encryption keys survive the namespacing change.
 *   3. Local SQLite   — `ATTACH DATABASE` the legacy `thunderbolt-sync.db` into
 *      the new `server-<id>.db` and copy rows table-by-table, stamping
 *      `workspace_id` (and `scope` where applicable) on the way in.
 *
 * Each step is idempotent and runs at most once per device. Step 3's "already
 * ran" signal is the localStorage `pre_workspaces_attach_completed__<serverId>`
 * flag — see `completion-flag.ts` for the rationale.
 */

export { allLegacyTables, localLegacyTables, syncedLegacyTables } from './table-list'
export type { LegacyTable } from './table-list'
export { findLegacyDbFilename, legacyDbFilenames } from './legacy-db-path'
export type { LegacyDbFilename, LegacyDbProbeDeps, LegacyDbProbeResult } from './legacy-db-path'
export { openLegacyReader } from './legacy-reader'
export type { LegacyBackend, LegacyReader } from './legacy-reader'
export {
  isCompletionFlagSet,
  isDataCompletionFlagSet,
  isGlobalCompletionFlagSet,
  setCompletionFlag,
  setDataCompletionFlag,
  setGlobalCompletionFlag,
} from './completion-flag'
export { migrateLocalStorageIfNeeded } from './local-storage-migration'
export type { LocalStorageMigrationResult } from './local-storage-migration'
export { migrateEncryptionKeysIfNeeded } from './indexeddb-migration'
export type { IdbBackend, IndexedDbMigrationResult, KeyEntry } from './indexeddb-migration'
export { runLocalDbMigration } from './local-db-migration'
export type { RunLocalDbMigrationOpts, RunLocalDbMigrationResult } from './local-db-migration'
