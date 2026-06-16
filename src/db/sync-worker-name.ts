/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared naming convention for the PowerSync `SharedWorker`. The main thread sets
 * `name: workerNameFor(dbFilename)` when constructing the worker; the worker (which
 * has no `localStorage` and thus can't hydrate the trust-domain registry) recovers
 * its own `serverId` from `self.name` via `serverIdFromWorkerName`. Co-locating the
 * producer + consumer here makes the round-trip a single source of truth — if the
 * format ever changes, both ends stay in sync.
 */

const prefix = 'shared-sync-'
const serverPattern = /^shared-sync-server-(.+)\.db$/

/** Build the SharedWorker `name` for the given DB filename. */
export const workerNameFor = (dbFilename: string): string => `${prefix}${dbFilename}`

/**
 * Recover the active server's `serverId` from a worker `name`, or `undefined` for the
 * standalone worker (where no server is associated). Used by `src/crypto/key-storage.ts`
 * to namespace the encryption-keys IDB from inside the SharedWorker context.
 */
export const serverIdFromWorkerName = (workerName: string | undefined): string | undefined => {
  return workerName?.match(serverPattern)?.[1]
}
