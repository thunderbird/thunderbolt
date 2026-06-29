/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Step 2 of the pre-Workspaces v1 data migration. Copies the legacy
 * `thunderbolt-keys` IndexedDB database into the per-server namespaced
 * `thunderbolt-keys__<serverId>` so the Workspaces v1 build can decrypt the
 * user's existing E2EE content without re-enrolling the device.
 *
 * The 'keys' object store holds (at most) five entries:
 *   thunderbolt_private_key, thunderbolt_public_key,
 *   thunderbolt_mlkem_public_key, thunderbolt_mlkem_secret_key, thunderbolt_ck
 *
 * Entries that already exist in the new DB are NOT overwritten — the
 * workspaces build may have generated its own keys before this migration ran
 * (e.g. user enabled E2EE on the new build first); those reflect what the BE
 * currently knows about this device and must win. Missing entries are copied
 * from the legacy DB.
 *
 * The legacy `thunderbolt-keys` DB is **left in place indefinitely** so a
 * rollback to the pre-Workspaces build finds the user's E2EE key material
 * intact. The new build never opens it, so it costs a few KB of dead weight
 * in IndexedDB. Same rollback-safety stance as the legacy SQLite file and
 * localStorage keys (see `docs/workspaces-v1-data-migration-plan.md`).
 */

const keyStoreObjectStoreName = 'keys'
const legacyDbName = 'thunderbolt-keys'
const dbVersion = 1

export type KeyEntry = { id: string; value: unknown }

export type IdbBackend = {
  /**
   * Open `dbName` and return every entry in the 'keys' object store. Returns
   * `[]` when the DB doesn't exist, the store doesn't exist, or the store is
   * empty — every "nothing to migrate" case collapses to the same shape.
   */
  readKeyEntries: (dbName: string) => Promise<KeyEntry[]>

  /**
   * Open `dbName` (creating the 'keys' store on first open) and `put` each
   * entry whose `id` isn't already present. Returns the number of entries
   * actually written. Entries with an existing id are skipped so the
   * workspaces-build value wins.
   */
  writeKeyEntriesIfMissing: (dbName: string, entries: KeyEntry[]) => Promise<number>
}

const newDbNameFor = (serverId: string): string => `thunderbolt-keys__${serverId}`

const wrapRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const wrapTx = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })

const openExisting = (dbName: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    // No `version` argument: open at the current version, create at v1 if the
    // DB doesn't exist. We never create the 'keys' store here — a freshly
    // created DB has no stores, which `readKeyEntries` treats as "nothing to
    // migrate" and the caller cleans up via `deleteDatabase`.
    const req = indexedDB.open(dbName)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const openWithStore = (dbName: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, dbVersion)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(keyStoreObjectStoreName)) {
        db.createObjectStore(keyStoreObjectStoreName)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const idbAvailable = (): boolean => typeof indexedDB !== 'undefined'

const browserIdbBackend: IdbBackend = {
  readKeyEntries: async (dbName) => {
    if (!idbAvailable()) {
      return []
    }
    const db = await openExisting(dbName)
    if (!db.objectStoreNames.contains(keyStoreObjectStoreName)) {
      db.close()
      return []
    }
    try {
      const tx = db.transaction(keyStoreObjectStoreName, 'readonly')
      const store = tx.objectStore(keyStoreObjectStoreName)
      const keys = (await wrapRequest(store.getAllKeys())) as IDBValidKey[]
      const values = await wrapRequest(store.getAll())
      await wrapTx(tx)
      return keys.map((id, index) => ({ id: String(id), value: values[index] }))
    } finally {
      db.close()
    }
  },

  writeKeyEntriesIfMissing: async (dbName, entries) => {
    if (!idbAvailable() || entries.length === 0) {
      return 0
    }
    const db = await openWithStore(dbName)
    try {
      const tx = db.transaction(keyStoreObjectStoreName, 'readwrite')
      const store = tx.objectStore(keyStoreObjectStoreName)
      const existingKeys = new Set(((await wrapRequest(store.getAllKeys())) as IDBValidKey[]).map(String))
      let written = 0
      for (const entry of entries) {
        if (existingKeys.has(entry.id)) {
          continue
        }
        store.put(entry.value, entry.id)
        written += 1
      }
      await wrapTx(tx)
      return written
    } finally {
      db.close()
    }
  },
}

export type IndexedDbMigrationResult = {
  migrated: boolean
  entryCount: number
}

/**
 * Returns `{ migrated, entryCount }` for telemetry. `migrated = true` iff at
 * least one entry was copied into the new DB. `entryCount` is the number of
 * entries actually written (skipping any already-present in the new DB).
 *
 * `backend` is exposed for tests — happy-dom doesn't provide `indexedDB`.
 * Production callers leave it defaulted.
 */
export const migrateEncryptionKeysIfNeeded = async (
  serverId: string,
  backend: IdbBackend = browserIdbBackend,
): Promise<IndexedDbMigrationResult> => {
  const entries = await backend.readKeyEntries(legacyDbName)
  if (entries.length === 0) {
    return { migrated: false, entryCount: 0 }
  }
  const written = await backend.writeKeyEntriesIfMissing(newDbNameFor(serverId), entries)
  return { migrated: written > 0, entryCount: written }
}
