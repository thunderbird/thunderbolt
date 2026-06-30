/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `buildPromptBlocks` attachment delivery (THU-628). Focuses on the no-
 * `embeddedContext` graceful-degradation branch: a text-extractable file is sent
 * as a `text` block; anything else gets a visible "could not be delivered" note
 * rather than being silently dropped. The text transformer and on-device blob
 * store are mocked, so this needs neither pdfjs nor IndexedDB.
 *
 * Mocks are registered before the dynamic import below — bun applies
 * `mock.module` at call time to subsequent imports (not hoisted), so the module
 * under test must be imported after.
 */

import { describe, expect, it, mock } from 'bun:test'

// PDF has a text transformer; everything else (e.g. images) has none.
mock.module('@/files/transformers', () => ({
  getTransformer: async (mime: string, target: string) =>
    mime === 'application/pdf' && target === 'text' ? async () => ({ text: 'EXTRACTED PDF TEXT' }) : null,
}))

// Any non-null stored file; the mocked transformer ignores the bytes.
mock.module('@/lib/file-blob-storage', () => ({
  getAttachment: async () => ({ blob: new Blob(['x']) }),
}))

const { buildPromptBlocks } = await import('./acp-adapter')
const { buildAttachmentPart } = await import('@/lib/attachments')

type Block = { type: string; text?: string }

const initWith = (parts: unknown[]): RequestInit => ({
  body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts }] }),
})

const pdf = () => buildAttachmentPart({ localFileId: 'f1', filename: 'doc.pdf', mimeType: 'application/pdf' })
const png = () => buildAttachmentPart({ localFileId: 'f2', filename: 'pic.png', mimeType: 'image/png' })
const textPart = (text: string) => ({ type: 'text', text })

describe('buildPromptBlocks — no embeddedContext', () => {
  it('sends a text-extractable file as an extracted text block', async () => {
    const blocks = (await buildPromptBlocks(initWith([textPart('hi'), pdf()]), undefined, false)) as Block[]

    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: 'hi' })
    expect(blocks[1]?.type).toBe('text')
    expect(blocks[1]?.text).toBe('[Attachment: doc.pdf]\n\nEXTRACTED PDF TEXT')
  })

  it('flags a non-text file as undeliverable instead of dropping it silently', async () => {
    const blocks = (await buildPromptBlocks(initWith([textPart('hi'), png()]), undefined, false)) as Block[]

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toContain('hi')
    expect(blocks[0]?.text).toContain('[Attachment "pic.png" could not be delivered to this agent]')
  })

  it('mixes both: text block for the PDF, note for the image', async () => {
    const blocks = (await buildPromptBlocks(initWith([textPart('hi'), pdf(), png()]), undefined, false)) as Block[]

    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.text).toContain('[Attachment "pic.png" could not be delivered to this agent]')
    expect(blocks[0]?.text).not.toContain('doc.pdf')
    expect(blocks[1]?.text).toBe('[Attachment: doc.pdf]\n\nEXTRACTED PDF TEXT')
  })

  it('with no attachments, returns a single text block (no note)', async () => {
    const blocks = (await buildPromptBlocks(initWith([textPart('just text')]), undefined, false)) as Block[]

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ type: 'text', text: 'just text' })
  })
})
