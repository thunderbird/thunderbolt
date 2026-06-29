/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isOpfsAvailable as defaultIsOpfsAvailable } from '@/lib/platform'
import type { LegacyBackend } from './legacy-reader'

/**
 * Legacy SQLite filenames the pre-workspaces builds wrote to:
 *
 *   - `thunderbolt-sync.db` — the PowerSync-era wa-sqlite file (last used by
 *     the build immediately preceding Workspaces v1).
 *   - `thunderbolt.db` — the pre-PowerSync wa-sqlite filename. Some long-time
 *     users still have this file from before the PowerSync migration.
 *
 * Probed in order; the first hit wins. `thunderbolt-sync.db` is checked first
 * because it's the more recent file — if both exist, the newer one carries the
 * more complete state.
 */
export const legacyDbFilenames = ['thunderbolt-sync.db', 'thunderbolt.db'] as const

export type LegacyDbFilename = (typeof legacyDbFilenames)[number]

const fileExistsInOpfs = async (root: FileSystemDirectoryHandle, name: string): Promise<boolean> => {
  try {
    await root.getFileHandle(name)
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return false
    }
    throw err
  }
}

/**
 * Probe IndexedDB for a wa-sqlite database stored by `IDBBatchAtomicVFS`.
 * Chrome/Edge/Firefox web builds use that VFS (per `getPowerSyncOptions`'s
 * `default` config), which stores each SQLite file as an IDB database named
 * after the filename.
 *
 * Prefers `indexedDB.databases()` (Chrome/Edge/Safari/Firefox 126+). Falls
 * back to a probe-then-delete-stub approach for older Firefox: open the DB,
 * inspect `oldVersion` in `onupgradeneeded` (0 means the DB didn't exist),
 * then `deleteDatabase` if we created a stub.
 */
const databaseExistsInIdb = async (name: string): Promise<boolean> => {
  if (typeof indexedDB === 'undefined') {
    return false
  }
  if (typeof indexedDB.databases === 'function') {
    try {
      const dbs = await indexedDB.databases()
      return dbs.some((d) => d.name === name)
    } catch {
      // Fall through to the probe-via-open fallback below. Some browsers
      // throw on `.databases()` under restricted contexts.
    }
  }
  return await new Promise<boolean>((resolve) => {
    let existedBefore = true
    const req = indexedDB.open(name)
    req.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        existedBefore = false
      }
      // Intentionally don't create any object stores — we're only probing.
    }
    req.onsuccess = () => {
      const db = req.result
      db.close()
      if (!existedBefore) {
        // Clean up the empty stub our probe just created.
        indexedDB.deleteDatabase(name)
      }
      resolve(existedBefore)
    }
    req.onerror = () => resolve(false)
    req.onblocked = () => resolve(false)
  })
}

export type LegacyDbProbeDeps = {
  isOpfsAvailable?: () => Promise<boolean>
  getStorageRoot?: () => Promise<FileSystemDirectoryHandle>
  /**
   * IDB existence probe. Injectable for tests (happy-dom doesn't implement
   * IndexedDB). Production callers leave it defaulted to the real probe.
   */
  idbDatabaseExists?: (name: string) => Promise<boolean>
}

/**
 * Where the legacy file lives. The backend determines which VFS the
 * legacy-reader needs to register when opening the file.
 */
export type LegacyDbProbeResult = {
  filename: LegacyDbFilename
  backend: LegacyBackend
}

/**
 * Returns the legacy SQLite file's filename and backend, or `null` when none
 * exists. Probes BOTH backends because the codebase splits VFS by platform
 * (see `getPowerSyncOptions` in `src/db/powersync/database.ts`):
 *
 *   - OPFS (`OPFSCoopSyncVFS`): Tauri builds + Safari web. File is an OPFS
 *     entry at the root with the literal filename.
 *   - IDB (`IDBBatchAtomicVFS`): Chrome/Edge/Firefox web. File is an IDB
 *     *database* named after the filename.
 *
 * OPFS is checked first because it's cheap (file-handle lookup, no async
 * round-trip). IDB only runs when OPFS misses, so the IDB-only cohort still
 * pays a single `databases()` round-trip rather than two.
 *
 * Deps are exposed for tests (happy-dom doesn't implement either backend).
 * Production callers leave them defaulted.
 */
export const findLegacyDbFilename = async ({
  isOpfsAvailable = defaultIsOpfsAvailable,
  getStorageRoot = () => navigator.storage.getDirectory(),
  idbDatabaseExists = databaseExistsInIdb,
}: LegacyDbProbeDeps = {}): Promise<LegacyDbProbeResult | null> => {
  if (await isOpfsAvailable()) {
    const root = await getStorageRoot()
    for (const name of legacyDbFilenames) {
      if (await fileExistsInOpfs(root, name)) {
        return { filename: name, backend: 'opfs' }
      }
    }
  }
  for (const name of legacyDbFilenames) {
    if (await idbDatabaseExists(name)) {
      return { filename: name, backend: 'idb' }
    }
  }
  return null
}
