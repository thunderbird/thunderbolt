/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { describe, expect, it } from 'bun:test'
import { getAttachment, putAttachments, type StoredFile } from './file-blob-storage'

const makeFile = (id: string): StoredFile => ({
  id,
  filename: `${id}.docx`,
  mimeType: 'application/octet-stream',
  size: 1,
  createdAt: 0,
  blob: new Blob([new Uint8Array([1])]),
})

describe('putAttachments', () => {
  it('stores every record of a valid batch', async () => {
    await putAttachments([makeFile('batch-a'), makeFile('batch-b')])

    expect(await getAttachment('batch-a')).not.toBeNull()
    expect(await getAttachment('batch-b')).not.toBeNull()
  })

  it('stores nothing when one record is invalid', async () => {
    const { id: _id, ...withoutId } = makeFile('unused')
    const invalid = withoutId as StoredFile

    await expect(putAttachments([makeFile('rolled-back'), invalid])).rejects.toThrow('Failed to store attachments')
    expect(await getAttachment('rolled-back')).toBeNull()
  })
})
