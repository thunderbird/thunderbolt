/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { docxMime } from '@/files/transformers'
import * as attachmentStorage from '@/lib/file-blob-storage'
import { expectSampleDocxPreview, waitForPreviewFrame } from '@/test-utils/docx-preview'
import { sampleDocx } from '@/test-utils/sample-docx'
import { parseXmlWithXmlDom } from '@/test-utils/xml-dom-parser'
import { FileCard } from './file-card'

describe('FileCard with a DOCX', () => {
  parseXmlWithXmlDom()
  beforeAll(async () => {
    const blob = await sampleDocx()
    spyOn(attachmentStorage, 'getAttachment').mockResolvedValue({
      id: 'local-1',
      filename: 'report.docx',
      mimeType: docxMime,
      size: blob.size,
      createdAt: 0,
      blob,
    })
  })

  afterEach(cleanup)
  afterAll(() => mock.restore())

  test('shows the document as its thumbnail, in a sandboxed frame', async () => {
    const { container } = render(<FileCard localFileId="local-1" filename="report.docx" mimeType={docxMime} />)

    const frame = await waitForPreviewFrame(() => container.querySelector('iframe'))
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.title).toBe('report.docx')
    expectSampleDocxPreview(frame.srcdoc)
  })
})
