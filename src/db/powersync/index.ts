/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export { AppSchema, drizzleSchema } from './schema'
export { ThunderboltConnector } from './connector'
export { PowerSyncDatabaseImpl } from './database'
// Re-exported for convenience inside the lazy-loaded PowerSync graph. Entry-bundle
// code must import these from './sync-state' directly — importing this barrel pulls
// the whole SDK into the entry chunk (defeats the dynamic import in src/db/database.ts).
export {
  getPowerSyncInstance,
  isSyncEnabled,
  reconnectSync,
  setSyncEnabled,
  syncEnabledChangeEvent,
} from './sync-state'
