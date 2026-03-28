import { StorageError } from './errors'

const dbName = 'thunderbolt-keys'
const storeName = 'keys'
const dbVersion = 1

const privateKeyId = 'thunderbolt_private_key'
const publicKeyId = 'thunderbolt_public_key'
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

const putKey = async (id: string, key: CryptoKey): Promise<void> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(key, id)
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

const getKey = async (id: string): Promise<CryptoKey | null> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).get(id)
    request.onsuccess = () => {
      db.close()
      resolve((request.result as CryptoKey) ?? null)
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

// =============================================================================
// Key pair (RSA-OAEP)
// =============================================================================

/** Store the device key pair in IndexedDB. */
export const storeKeyPair = async (privateKey: CryptoKey, publicKey: CryptoKey): Promise<void> => {
  await putKey(privateKeyId, privateKey)
  await putKey(publicKeyId, publicKey)
}

/** Get the device key pair from IndexedDB. Returns null if either key is missing. */
export const getKeyPair = async (): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey } | null> => {
  const privateKey = await getKey(privateKeyId)
  const publicKey = await getKey(publicKeyId)
  if (!privateKey || !publicKey) {
    return null
  }
  return { privateKey, publicKey }
}

// =============================================================================
// Content Key (AES-256-GCM)
// =============================================================================

/** Store the content key in IndexedDB. */
export const storeCK = async (ck: CryptoKey): Promise<void> => putKey(ckId, ck)

/** Get the content key from IndexedDB. */
export const getCK = async (): Promise<CryptoKey | null> => getKey(ckId)

/** Clear only the content key (for sign-out — key pair is preserved). */
export const clearCK = async (): Promise<void> => deleteKey(ckId)

// =============================================================================
// Full wipe
// =============================================================================

/** Clear all keys from IndexedDB (for full data wipe / revocation). */
export const clearAllKeys = async (): Promise<void> => {
  await deleteKey(privateKeyId)
  await deleteKey(publicKeyId)
  await deleteKey(ckId)
}
