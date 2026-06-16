/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { serverIdFromWorkerName } from '@/db/sync-worker-name'
import { getActiveServerId } from '@/stores/trust-domain-registry'
import { StorageError } from './errors'

// IndexedDB DB name is namespaced by the active server's `serverId` so multiple
// servers' encryption keys can coexist without leaking across trust domains.
// E2E encryption only applies in server trust domains — callers MUST resolve an
// active server before invoking any helper here.
const dbNamePrefix = 'thunderbolt-keys__'
const storeName = 'keys'
const dbVersion = 1

const privateKeyId = 'thunderbolt_private_key'
const publicKeyId = 'thunderbolt_public_key'
const mlkemPublicKeyId = 'thunderbolt_mlkem_public_key'
const mlkemSecretKeyId = 'thunderbolt_mlkem_secret_key'
const ckId = 'thunderbolt_ck'

/**
 * Resolve the active server's `serverId` for key storage. Main thread reads from the
 * trust-domain registry (Zustand + localStorage). The PowerSync SharedWorker — where
 * the encryption codec also runs to decrypt incoming buckets — has no `localStorage`
 * access, so the registry hydrates to its initial empty state in that context. We
 * recover the `serverId` from `self.name` via the shared `sync-worker-name` helper,
 * which is the same helper the producer (`getPowerSyncOptions`) uses to construct it.
 */
const resolveServerId = (): string | undefined => {
  if (typeof window !== 'undefined') {
    return getActiveServerId()
  }
  const workerName = typeof self !== 'undefined' ? (self as unknown as { name?: string }).name : undefined
  return serverIdFromWorkerName(workerName)
}

/** Resolve the IDB DB name for the active server. Throws when there is no active server. */
const resolveDbName = (): string => {
  const serverId = resolveServerId()
  if (!serverId) {
    throw new StorageError('Cannot access encryption-key storage without an active server trust domain')
  }
  return `${dbNamePrefix}${serverId}`
}

// =============================================================================
// IndexedDB helpers
// =============================================================================

const openDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(resolveDbName(), dbVersion)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new StorageError('Failed to open IndexedDB', { cause: request.error }))
  })

type StorableValue = CryptoKey | Uint8Array

const putValue = async (id: string, value: StorableValue): Promise<void> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(value, id)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(new StorageError(`Failed to store key: ${id}`, { cause: tx.error }))
    }
  })
}

const getValue = async <T extends StorableValue>(id: string): Promise<T | null> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).get(id)
    request.onsuccess = () => {
      db.close()
      resolve((request.result as T) ?? null)
    }
    request.onerror = () => {
      db.close()
      reject(new StorageError(`Failed to get key: ${id}`, { cause: request.error }))
    }
  })
}

const getEntries = async <T extends StorableValue>(ids: string[]): Promise<Array<T | null>> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const requests = ids.map((id) => store.get(id))
    tx.oncomplete = () => {
      db.close()
      resolve(requests.map((r) => (r.result as T) ?? null))
    }
    tx.onerror = () => {
      db.close()
      reject(new StorageError('Failed to get keys', { cause: tx.error }))
    }
  })
}

const deleteKey = async (id: string): Promise<void> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).delete(id)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(new StorageError(`Failed to delete key: ${id}`, { cause: tx.error }))
    }
  })
}

const putEntries = async (entries: Array<{ id: string; value: StorableValue }>): Promise<void> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    for (const { id, value } of entries) {
      store.put(value, id)
    }
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(new StorageError('Failed to store keys', { cause: tx.error }))
    }
  })
}

// =============================================================================
// Key pair (ECDH P-256 + ML-KEM-768)
// =============================================================================

export type StoredKeyPair = {
  ecdhPrivateKey: CryptoKey
  ecdhPublicKey: CryptoKey
  mlkemPublicKey: Uint8Array
  mlkemSecretKey: Uint8Array
}

/** Store both ECDH and ML-KEM key pairs in IndexedDB (single atomic transaction). */
export const storeKeyPair = async (
  ecdhPrivateKey: CryptoKey,
  ecdhPublicKey: CryptoKey,
  mlkemPublicKey: Uint8Array,
  mlkemSecretKey: Uint8Array,
): Promise<void> =>
  putEntries([
    { id: privateKeyId, value: ecdhPrivateKey },
    { id: publicKeyId, value: ecdhPublicKey },
    { id: mlkemPublicKeyId, value: mlkemPublicKey },
    { id: mlkemSecretKeyId, value: mlkemSecretKey },
  ])

/** Get both key pairs from IndexedDB (single transaction). Returns null if any key is missing. */
export const getKeyPair = async (): Promise<StoredKeyPair | null> => {
  const [ecdhPrivateKey, ecdhPublicKey, mlkemPublicKey, mlkemSecretKey] = await getEntries<StorableValue>([
    privateKeyId,
    publicKeyId,
    mlkemPublicKeyId,
    mlkemSecretKeyId,
  ])
  if (!ecdhPrivateKey || !ecdhPublicKey || !mlkemPublicKey || !mlkemSecretKey) {
    return null
  }
  return {
    ecdhPrivateKey: ecdhPrivateKey as CryptoKey,
    ecdhPublicKey: ecdhPublicKey as CryptoKey,
    mlkemPublicKey: mlkemPublicKey as Uint8Array,
    mlkemSecretKey: mlkemSecretKey as Uint8Array,
  }
}

// =============================================================================
// Content Key (AES-256-GCM)
// =============================================================================

/** Store the content key in IndexedDB. */
export const storeCK = async (ck: CryptoKey): Promise<void> => putValue(ckId, ck)

/** Get the content key from IndexedDB. */
export const getCK = async (): Promise<CryptoKey | null> => getValue<CryptoKey>(ckId)

/** Clear only the content key (key pair is preserved). */
export const clearCK = async (): Promise<void> => deleteKey(ckId)

// =============================================================================
// Full wipe
// =============================================================================

/**
 * Clear all keys and delete the IDB database for the given server (full data
 * wipe / revocation). The `serverId` defaults to the active server in the
 * trust-domain registry, but callers running after the registry has been
 * cleared (the cleanup pipeline does this early to keep reloaded tabs out of
 * the wiping server) must pass it explicitly — otherwise the wipe would no-op
 * and leave the per-server IDB database on disk.
 */
export const clearAllKeys = async (serverId?: string): Promise<void> => {
  const resolvedServerId = serverId ?? resolveServerId()
  if (!resolvedServerId) {
    throw new StorageError('Cannot clear encryption keys without an active server trust domain')
  }
  const dbName = `${dbNamePrefix}${resolvedServerId}`
  // Best-effort per-key delete first so a blocked `deleteDatabase` (open
  // connection in another tab) still leaves no key material behind.
  try {
    await deleteKeysInDB(dbName, [privateKeyId, publicKeyId, mlkemPublicKeyId, mlkemSecretKeyId, ckId])
  } catch (err) {
    console.warn(`[clearAllKeys] per-key delete failed for ${dbName}; relying on deleteDatabase`, err)
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(dbName)
    request.onsuccess = () => resolve()
    request.onerror = () => {
      console.error(`[clearAllKeys] Failed to delete IDB database ${dbName}:`, request.error)
      resolve()
    }
    request.onblocked = () => {
      console.warn(`[clearAllKeys] IDB delete blocked for ${dbName} — open connections still alive`)
      resolve()
    }
  })
}

/** Internal: open the IDB DB by explicit name and delete the listed keys. Mirrors `deleteKeys` but doesn't go through `resolveDbName`. */
const deleteKeysInDB = async (dbName: string, ids: string[]): Promise<void> => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion)
    request.onupgradeneeded = () => {
      const upgradeDb = request.result
      if (!upgradeDb.objectStoreNames.contains(storeName)) {
        upgradeDb.createObjectStore(storeName)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new StorageError('Failed to open IndexedDB', { cause: request.error }))
  })
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    for (const id of ids) {
      store.delete(id)
    }
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(new StorageError('Failed to delete keys', { cause: tx.error }))
    }
  })
}
