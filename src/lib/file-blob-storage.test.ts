/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { describe, expect, it } from 'bun:test'
import { getAttachment, putAttachment, putAttachments, type StoredFile } from './file-blob-storage'
import { attachmentDatabaseName } from './local-data-owner'

const makeFile = (id: string): StoredFile => ({
  id,
  filename: `${id}.docx`,
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 3,
  createdAt: 0,
  blob: new Blob([new Uint8Array([1, 2, 3])]),
})

/** The two shapes of bytes a stored record may hold. */
type RawRecord = { bytes?: ArrayBuffer; blob?: Blob }

/** The raw record IndexedDB holds for `id`. */
const rawRecord = async (id: string): Promise<RawRecord> => {
  const request = indexedDB.open(attachmentDatabaseName())
  const db = await new Promise<IDBDatabase>((resolve) => (request.onsuccess = () => resolve(request.result)))
  const get = db.transaction('attachments').objectStore('attachments').get(id)
  const record = await new Promise<RawRecord>((resolve) => (get.onsuccess = () => resolve(get.result)))
  db.close()
  return record
}

describe('putAttachments', () => {
  it('stores every record of a valid batch', async () => {
    await putAttachments([makeFile('batch-a'), makeFile('batch-b')])

    expect(await getAttachment('batch-a')).not.toBeNull()
    expect(await getAttachment('batch-b')).not.toBeNull()
  })

  it('stores the bytes as an ArrayBuffer, not a Blob, and reads them back as a Blob of the file type', async () => {
    await putAttachment(makeFile('as-bytes'))

    const raw = await rawRecord('as-bytes')
    expect(raw.bytes).toBeInstanceOf(ArrayBuffer)
    expect(raw.blob).toBeUndefined()
    const file = await getAttachment('as-bytes')
    expect(file?.blob.type).toBe(makeFile('as-bytes').mimeType)
    expect([...new Uint8Array(await file!.blob.arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('stores nothing when one record is invalid, and says which files could not be saved', async () => {
    const { id: _id, ...withoutId } = makeFile('unused')
    const invalid = withoutId as StoredFile

    await expect(putAttachments([makeFile('rolled-back'), invalid])).rejects.toThrow(
      'Could not save "rolled-back.docx", "unused.docx" in this browser\'s local storage',
    )
    expect(await getAttachment('rolled-back')).toBeNull()
  })
})

describe('getAttachment', () => {
  // The fake IndexedDB under Bun does not keep a Blob's bytes, so this checks only that such a record is not converted.
  it('reads a record stored with its bytes as a Blob as it is', async () => {
    await putAttachment(makeFile('seed'))
    const request = indexedDB.open(attachmentDatabaseName())
    const db = await new Promise<IDBDatabase>((resolve) => (request.onsuccess = () => resolve(request.result)))
    const tx = db.transaction('attachments', 'readwrite')
    tx.objectStore('attachments').put(makeFile('old-format'))
    await new Promise((resolve) => (tx.oncomplete = resolve))
    db.close()

    const raw = await rawRecord('old-format')
    expect(raw.blob).toBeDefined()
    expect((await getAttachment('old-format'))?.blob).toEqual(raw.blob!)
  })
})
