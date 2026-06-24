/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import { describe, expect, test } from 'bun:test'
import { attachmentPartType, buildAttachmentPart, getAttachments, isAttachmentPart } from './attachments'

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
