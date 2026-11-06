/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StoredFile } from '@/lib/file-blob-storage'
import type { ThunderboltUIMessage } from '@/types'
import { describe, expect, test } from 'bun:test'
import {
  attachmentPartType,
  buildAttachmentPart,
  getAttachments,
  hydrateAttachmentsAsFileParts,
  type HydrationDeps,
  isAttachmentPart,
} from './attachments'

const data = { localFileId: 'f1', filename: 'doc.pdf', mimeType: 'application/pdf' }

describe('attachments', () => {
  test('buildAttachmentPart wraps the reference in a data-attachment part', () => {
    expect(buildAttachmentPart(data)).toEqual({ type: attachmentPartType, data })
  })

  test('isAttachmentPart matches only attachment parts', () => {
    expect(isAttachmentPart({ type: attachmentPartType })).toBe(true)
    expect(isAttachmentPart({ type: 'text' })).toBe(false)
  })

  test('getAttachments extracts references in order, ignoring other parts', () => {
    const message = {
      id: 'm1',
      role: 'user',
      parts: [
        { type: 'text', text: 'hello' },
        buildAttachmentPart(data),
        buildAttachmentPart({ localFileId: 'f2', filename: 'b.pdf', mimeType: 'application/pdf' }),
      ],
    } as unknown as ThunderboltUIMessage

    expect(getAttachments(message).map((a) => a.localFileId)).toEqual(['f1', 'f2'])
  })
})

describe('hydrateAttachmentsAsFileParts — history reduction', () => {
  // Text transformer for pdf/csv; nothing for images. Bytes are ignored by the fakes.
  const deps: HydrationDeps = {
    getAttachment: async () => ({ blob: new Blob(['x']) }) as StoredFile,
    getTransformer: async (mime, target) =>
      target === 'text' && (mime === 'application/pdf' || mime === 'text/csv')
        ? async () => ({ text: 'EXTRACTED' })
        : null,
  }

  const textPart = (text: string) => ({ type: 'text', text })
  const partTypes = (m: ThunderboltUIMessage) => m.parts.map((p) => p.type)
  const texts = (m: ThunderboltUIMessage) =>
    m.parts.flatMap((p) => (p.type === 'text' ? [(p as { text: string }).text] : []))

  const conversation = () =>
    [
      {
        id: 'u1',
        role: 'user',
        parts: [
          textPart('summarize'),
          buildAttachmentPart({ localFileId: 'f1', filename: 'doc.pdf', mimeType: 'application/pdf' }),
          buildAttachmentPart({ localFileId: 'f2', filename: 'pic.png', mimeType: 'image/png' }),
        ],
      },
      { id: 'a1', role: 'assistant', parts: [textPart('ok')] },
      {
        id: 'u2',
        role: 'user',
        parts: [
          textPart('and this'),
          buildAttachmentPart({ localFileId: 'f3', filename: 'data.csv', mimeType: 'text/csv' }),
        ],
      },
    ] as unknown as ThunderboltUIMessage[]

  test('earlier-turn attachments are reduced to text/reference, never native bytes', async () => {
    const [u1] = await hydrateAttachmentsAsFileParts(conversation(), deps)

    // No native `file` parts replayed from history — this is what prevents thread poisoning.
    expect(partTypes(u1).filter((t) => t === 'file')).toHaveLength(0)
    // PDF (text-extractable) → its text; image (no transformer) → a bare reference.
    expect(texts(u1)).toEqual(['summarize', '[Attachment: doc.pdf]\n\nEXTRACTED', '[Attachment: pic.png]'])
  })

  test('an unreadable attachment is skipped instead of failing the turn', async () => {
    // The reported bug: a file stored as a reference to a path on disk (rather
    // than a copy of its bytes) throws once the source is edited. Because every
    // send re-reads the whole history, letting that propagate failed the turn,
    // burned all three auto-retries, and broke even a plain-text follow-up.
    const unreadable: HydrationDeps = {
      ...deps,
      getTransformer: async () => async () => {
        throw new DOMException('The requested file could not be read', 'NotReadableError')
      },
    }

    const result = await hydrateAttachmentsAsFileParts(conversation(), unreadable)

    // The turn survives, carrying the user's text and the attachment reference.
    expect(texts(result[0])).toContain('summarize')
    expect(result).toHaveLength(3)
  })

  test('one unreadable attachment does not take the readable ones with it', async () => {
    const oneBadFile: HydrationDeps = {
      ...deps,
      getAttachment: async (id: string) => {
        if (id === 'f1') {
          throw new DOMException('gone', 'NotReadableError')
        }
        return { blob: new Blob(['x']) } as StoredFile
      },
    }

    const result = await hydrateAttachmentsAsFileParts(conversation(), oneBadFile)

    // f3 (csv, latest turn) still extracts even though f1 could not be read.
    expect(texts(result[2])).toEqual(['and this', '[Attachment: data.csv]\n\nEXTRACTED'])
  })

  test('the latest turn still delivers its attachment in full (here: csv as text)', async () => {
    const result = await hydrateAttachmentsAsFileParts(conversation(), deps)
    const u2 = result[2]

    expect(texts(u2)).toEqual(['and this', '[Attachment: data.csv]\n\nEXTRACTED'])
  })

  test('an image on the latest turn would NOT be reduced (kept for full native delivery)', async () => {
    // Image as the current turn: no text/images transformer → falls through to native bytes,
    // i.e. it is NOT turned into a placeholder (that only happens once it's historical).
    const justImage = [
      {
        id: 'u1',
        role: 'user',
        parts: [buildAttachmentPart({ localFileId: 'f2', filename: 'pic.png', mimeType: 'image/png' })],
      },
    ] as unknown as ThunderboltUIMessage[]

    const [u1] = await hydrateAttachmentsAsFileParts(justImage, {
      ...deps,
      // Avoid the real FileReader-based native path in the test; assert via this marker instead.
      getAttachment: async () => ({ blob: new Blob(['img']) }) as StoredFile,
    })
    // Current-turn image is not reduced to a `[Attachment: …]` reference.
    expect(u1.parts.every((p) => p.type !== 'text' || !(p as { text: string }).text.startsWith('[Attachment:'))).toBe(
      true,
    )
  })
})
