import { StorageError } from './errors'

const dbName = 'thunderbolt-keys'
const storeName = 'keys'
const dbVersion = 1

const privateKeyId = 'thunderbolt_private_key'
const publicKeyId = 'thunderbolt_public_key'
const mlkemPublicKeyId = 'thunderbolt_mlkem_public_key'
const mlkemSecretKeyId = 'thunderbolt_mlkem_secret_key'
const ckId = 'thunderbolt_ck'

// =============================================================================
// IndexedDB helpers
// =============================================================================

const openDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion)
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

const deleteKeys = async (ids: string[]): Promise<void> => {
  const db = await openDB()
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

/** Get both key pairs from IndexedDB. Returns null if any key is missing. */
export const getKeyPair = async (): Promise<StoredKeyPair | null> => {
  const ecdhPrivateKey = await getValue<CryptoKey>(privateKeyId)
  const ecdhPublicKey = await getValue<CryptoKey>(publicKeyId)
  const mlkemPublicKey = await getValue<Uint8Array>(mlkemPublicKeyId)
  const mlkemSecretKey = await getValue<Uint8Array>(mlkemSecretKeyId)
  if (!ecdhPrivateKey || !ecdhPublicKey || !mlkemPublicKey || !mlkemSecretKey) {
    return null
  }
  return { ecdhPrivateKey, ecdhPublicKey, mlkemPublicKey, mlkemSecretKey }
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

/** Clear all keys from IndexedDB (single atomic transaction for full data wipe / revocation). */
export const clearAllKeys = async (): Promise<void> =>
  deleteKeys([privateKeyId, publicKeyId, mlkemPublicKeyId, mlkemSecretKeyId, ckId])
