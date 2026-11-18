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
    // The app's server answers the check made before the renderer is imported.
    spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null))
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

  /** WebKit puts focus inside a focusable frame, where Enter and Space cannot open the card. */
  test('keeps the thumbnail frame out of the tab order, so the card button takes the keys', async () => {
    const { container } = render(
      <FileCard localFileId="local-1" filename="report.docx" mimeType={docxMime} onOpen={() => {}} />,
    )

    const frame = await waitForPreviewFrame(() => container.querySelector('iframe'))
    expect(frame.tabIndex).toBe(-1)
  })
})

describe('FileCard names', () => {
  afterEach(cleanup)

  /** A right-to-left override would make `annual<RLO>xcod.xlsx` read as a `.docx`. */
  test('shows a name without its bidirectional controls, so the real extension shows', () => {
    const rightToLeftOverride = String.fromCharCode(0x202e)
    const { container, getByText } = render(
      <FileCard
        localFileId="local-2"
        filename={`annual${rightToLeftOverride}xcod.xlsx`}
        mimeType="text/csv"
        onOpen={() => {}}
        onRemove={() => {}}
      />,
    )

    expect(getByText('annualxcod.xlsx')).toBeDefined()
    expect(container.querySelector('button[title="annualxcod.xlsx"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Remove annualxcod.xlsx"]')).not.toBeNull()
  })
})
