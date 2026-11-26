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
 *
 * Each slot has its own attachment database next to its database file
 * (`attachmentDatabaseName`), so an account never reads another account's files.
 */

import { attachmentDatabaseName } from './local-data-owner'
import { promptFileName } from './safe-file-name'

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
    const request = indexedDB.open(attachmentDatabaseName(), dbVersion)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Failed to open attachment store', { cause: request.error }))
  })

/**
 * What the store holds. The bytes are an `ArrayBuffer`, because WebKit's private browsing refuses to store a `Blob`
 * in IndexedDB. Records written before that hold a `blob`, and are still read.
 */
type StoredRecord = Omit<StoredFile, 'blob'> & ({ bytes: ArrayBuffer } | { blob: Blob })

/** The record as callers see it, with its bytes as a `Blob` of the file's type. */
const toStoredFile = (record: StoredRecord): StoredFile => {
  if ('blob' in record) {
    return record
  }
  const { bytes, ...file } = record
  return { ...file, blob: new Blob([bytes], { type: file.mimeType }) }
}

/**
 * Persist attachments locally, as copies of the bytes, in one transaction: all of them are stored or none.
 *
 * A `File` from an `<input>` or a drop is a reference to a path, and IndexedDB stores it as one. Editing or moving the
 * source afterwards would make every later read throw `NotReadableError`, which breaks the whole conversation because
 * each send re-reads the history's attachments. Storing an `ArrayBuffer` copies the bytes here, once.
 */
export const putAttachments = async (files: StoredFile[]): Promise<void> => {
  const detached: StoredRecord[] = await Promise.all(
    files.map(async ({ blob, ...file }) => ({ ...file, bytes: await blob.arrayBuffer() })),
  )
  const names = files.map(({ filename }) => promptFileName(filename)).join(', ')
  const storeError = (cause: unknown) =>
    new Error(`Could not save ${names} in this browser's local storage, so it cannot be downloaded or attached.`, {
      cause,
    })
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    // A failed request aborts the transaction, and so does a full disk, so `abort` covers every failure.
    tx.onabort = () => {
      db.close()
      reject(storeError(tx.error))
    }
    const store = tx.objectStore(storeName)
    try {
      detached.forEach((file) => store.put(file))
    } catch (error) {
      // A `put` that throws (e.g. a record missing its key) does not abort the transaction, so earlier puts would commit.
      tx.abort()
      reject(storeError(error))
    }
  })
}

/** Persist an uploaded attachment locally, as a copy of the bytes. */
export const putAttachment = (file: StoredFile): Promise<void> => putAttachments([file])

/** Read a locally-stored attachment, or `null` if it isn't on this device. */
export const getAttachment = async (id: string): Promise<StoredFile | null> => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).get(id)
    request.onsuccess = () => {
      db.close()
      const record = request.result as StoredRecord | undefined
      resolve(record ? toStoredFile(record) : null)
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
