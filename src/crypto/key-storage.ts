/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { KeyId, WrappedKeyEntry } from '@shared/e2ee-types'

import { StorageError } from './errors'
import { decryptBytes, deriveMlKemAtRestKey, encryptBytes, type EncryptedBytes } from './primitives'

const dbName = 'thunderbolt-keys'
const storeName = 'keys'
// v2: the ML-KEM secret is encrypted at rest and the single `thunderbolt_ck`
// entry is replaced by `thunderbolt_ak` + dynamic `thunderbolt_dek_{keyId}`.
// The v1→v2 upgrade is NON-DESTRUCTIVE — existing entries (ECDH/ML-KEM key
// pairs) are preserved so a formerly-v1 device keeps its transport keys. A
// leftover v1 plaintext ML-KEM secret is re-encrypted lazily by `getKeyPair`
// (WS1.5 read-migration).
const dbVersion = 2

const privateKeyId = 'thunderbolt_private_key'
const publicKeyId = 'thunderbolt_public_key'
const mlkemPublicKeyId = 'thunderbolt_mlkem_public_key'
const mlkemSecretKeyId = 'thunderbolt_mlkem_secret_key'
const akId = 'thunderbolt_ak'
const dekIdPrefix = 'thunderbolt_dek_'
const primaryKeyIdId = 'thunderbolt_primary_key_id'
const keyVersionId = 'thunderbolt_key_version'

const dekEntryId = (keyId: KeyId): string => `${dekIdPrefix}${keyId}`

// =============================================================================
// IndexedDB helpers
// =============================================================================

const openDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion)
    request.onupgradeneeded = () => {
      // Non-destructive: only create the store when missing. NEVER delete it —
      // the v1→v2 upgrade must preserve the user's transport key pairs.
      const db = request.result
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new StorageError('Failed to open IndexedDB', { cause: request.error }))
  })

type StorableValue = CryptoKey | Uint8Array | EncryptedBytes | string

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

/**
 * Store both ECDH and ML-KEM key pairs in IndexedDB (single atomic transaction).
 * The ML-KEM secret key is encrypted at rest under a self-ECDH-derived AES-GCM
 * key (THU-427) — only `{iv, ciphertext}` ever touches the store.
 */
export const storeKeyPair = async (
  ecdhPrivateKey: CryptoKey,
  ecdhPublicKey: CryptoKey,
  mlkemPublicKey: Uint8Array,
  mlkemSecretKey: Uint8Array,
): Promise<void> => {
  const atRestKey = await deriveMlKemAtRestKey(ecdhPublicKey, ecdhPrivateKey)
  const encryptedSecret = await encryptBytes(mlkemSecretKey, atRestKey)
  return putEntries([
    { id: privateKeyId, value: ecdhPrivateKey },
    { id: publicKeyId, value: ecdhPublicKey },
    { id: mlkemPublicKeyId, value: mlkemPublicKey },
    { id: mlkemSecretKeyId, value: encryptedSecret },
  ])
}

/**
 * Get both key pairs from IndexedDB (single transaction). Returns null if any
 * key is missing.
 *
 * WS1.5 read-migration: v1 stored the ML-KEM secret as PLAINTEXT bytes. When a
 * raw `Uint8Array` is found (formerly-v1 device on a v2 build), it is used as-is
 * and re-encrypted in place in the v2 at-rest format, so subsequent reads take
 * the encrypted path. v2-written secrets are `EncryptedBytes` and get decrypted.
 */
export const getKeyPair = async (): Promise<StoredKeyPair | null> => {
  const [ecdhPrivateKey, ecdhPublicKey, mlkemPublicKey, storedSecret] = await getEntries<StorableValue>([
    privateKeyId,
    publicKeyId,
    mlkemPublicKeyId,
    mlkemSecretKeyId,
  ])
  if (!ecdhPrivateKey || !ecdhPublicKey || !mlkemPublicKey || !storedSecret) {
    return null
  }
  const atRestKey = await deriveMlKemAtRestKey(ecdhPublicKey as CryptoKey, ecdhPrivateKey as CryptoKey)

  if (storedSecret instanceof Uint8Array) {
    const encryptedSecret = await encryptBytes(storedSecret, atRestKey)
    await putValue(mlkemSecretKeyId, encryptedSecret)
    return {
      ecdhPrivateKey: ecdhPrivateKey as CryptoKey,
      ecdhPublicKey: ecdhPublicKey as CryptoKey,
      mlkemPublicKey: mlkemPublicKey as Uint8Array,
      mlkemSecretKey: storedSecret,
    }
  }

  const mlkemSecretKey = await decryptBytes(storedSecret as EncryptedBytes, atRestKey)
  return {
    ecdhPrivateKey: ecdhPrivateKey as CryptoKey,
    ecdhPublicKey: ecdhPublicKey as CryptoKey,
    mlkemPublicKey: mlkemPublicKey as Uint8Array,
    mlkemSecretKey,
  }
}

// =============================================================================
// AK (non-extractable AES-KW CryptoKey) + wrapped DEK keyring (base64 blobs)
// =============================================================================

/** Store the account key in IndexedDB. */
export const storeAK = async (ak: CryptoKey): Promise<void> => putValue(akId, ak)

/** Get the account key from IndexedDB. */
export const getAK = async (): Promise<CryptoKey | null> => getValue<CryptoKey>(akId)

/**
 * Store one DEK as its wrapped base64 AES-KW blob (NOT a CryptoKey). The
 * SharedWorker reads wrapped blobs + the AK and unwraps on demand, keeping the
 * AK as the keyring gate.
 */
export const storeDEK = async (keyId: KeyId, wrappedBase64: string): Promise<void> =>
  putValue(dekEntryId(keyId), wrappedBase64)

/** Get one DEK's wrapped base64 blob by key_id, or null when not staged. */
export const getDEK = async (keyId: KeyId): Promise<string | null> => getValue<string>(dekEntryId(keyId))

/** Stage the full wrapped-DEK keyring in one atomic transaction (§3 pre-staging). */
export const stageWrappedDEKs = async (entries: WrappedKeyEntry[]): Promise<void> =>
  putEntries(entries.map(({ keyId, wrappedKey }) => ({ id: dekEntryId(keyId), value: wrappedKey })))

/** List every staged DEK (enumerates `thunderbolt_dek_*` entries). */
export const listDEKs = async (): Promise<WrappedKeyEntry[]> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const keysRequest = store.getAllKeys()
    keysRequest.onsuccess = () => {
      const dekIds = keysRequest.result.filter(
        (id): id is string => typeof id === 'string' && id.startsWith(dekIdPrefix),
      )
      const valueRequests = dekIds.map((id) => store.get(id))
      tx.oncomplete = () => {
        db.close()
        resolve(
          dekIds.map((id, i) => ({
            keyId: id.slice(dekIdPrefix.length),
            wrappedKey: valueRequests[i].result as string,
          })),
        )
      }
    }
    tx.onerror = () => {
      db.close()
      reject(new StorageError('Failed to list DEKs', { cause: tx.error }))
    }
  })
}

/** Store the primary key_id pointer — the DEK version that encrypts all new writes. */
export const storePrimaryKeyId = async (keyId: KeyId): Promise<void> => putValue(primaryKeyIdId, keyId)

/** Get the primary key_id pointer, or null when it was never set. */
export const getPrimaryKeyId = async (): Promise<KeyId | null> => getValue<string>(primaryKeyIdId)

/**
 * Persist the last encryption-metadata `key_version` this device applied — the
 * baseline for the polled AK-rotation check (plan §2.4 polling transport).
 */
export const storeKeyVersion = async (version: number): Promise<void> => putValue(keyVersionId, String(version))

/** Get the last applied `key_version`, or null when never recorded. */
export const getKeyVersion = async (): Promise<number | null> => {
  const stored = await getValue<string>(keyVersionId)
  return stored === null ? null : Number(stored)
}

// =============================================================================
// Full wipe
// =============================================================================

/**
 * Clear all keys from IndexedDB (full data wipe / revocation). Enumerates the
 * store rather than deleting a static id list — DEK entries are dynamically
 * named (`thunderbolt_dek_{keyId}`) and would leak otherwise.
 */
export const clearAllKeys = async (): Promise<void> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    const keysRequest = store.getAllKeys()
    keysRequest.onsuccess = () => {
      for (const id of keysRequest.result) {
        store.delete(id)
      }
    }
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(new StorageError('Failed to clear keys', { cause: tx.error }))
    }
  })
}
