/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Local-only storage for uploaded chat attachments (e.g. PDFs).
 *
 * The blobs live in IndexedDB on the device and are NEVER written to a message
 * part or synced to the backend — message parts carry only a `localFileId`
 * reference (see the `data-attachment` part). This keeps file bytes off our
 * infrastructure: the local copy here powers the inline chip + viewer, while
 * sending to an agent hydrates the bytes on demand at request time.
 *
 * Mirrors the IndexedDB pattern in `src/crypto/key-storage.ts`.
 */

const dbName = 'thunderbolt-files'
const storeName = 'attachments'
const dbVersion = 1

/** A locally-stored attachment: metadata plus the raw bytes. */
export type StoredFile = {
  /** Local id (UUID) — the only thing persisted in the message part. */
  id: string
  filename: string
  mimeType: string
  /** Size in bytes. */
  size: number
  /** Epoch millis the file was stored. Passed in (Date.now is not deterministic). */
  createdAt: number
  blob: Blob
}

const openDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Failed to open attachment store', { cause: request.error }))
  })

/** Persist an uploaded attachment locally. */
export const putAttachment = async (file: StoredFile): Promise<void> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(file)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(new Error(`Failed to store attachment: ${file.id}`, { cause: tx.error }))
    }
  })
}

/** Read a locally-stored attachment, or `null` if it isn't on this device. */
export const getAttachment = async (id: string): Promise<StoredFile | null> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).get(id)
    request.onsuccess = () => {
      db.close()
      resolve((request.result as StoredFile | undefined) ?? null)
    }
    request.onerror = () => {
      db.close()
      reject(new Error(`Failed to read attachment: ${id}`, { cause: request.error }))
    }
  })
}

/** Delete a locally-stored attachment. */
export const deleteAttachment = async (id: string): Promise<void> => {
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
      reject(new Error(`Failed to delete attachment: ${id}`, { cause: tx.error }))
    }
  })
}
