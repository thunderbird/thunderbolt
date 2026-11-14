/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { docxMime } from '@/files/transformers'
import * as docxToHtmlModule from '@/files/transformers/docx-to-html'
import * as attachmentStorage from '@/lib/file-blob-storage'
import { bundleForBrowser } from '@/test-utils/bundle-for-browser'
import { expectSampleDocxPreview } from '@/test-utils/expect-sample-docx-preview'
import { sampleDocx } from '@/test-utils/sample-docx'
import { getClock } from '@/testing-library'
import { FileCard } from './file-card'

/** Ticks until the card's thumbnail frame holds its document, since the renderer reads the file asynchronously. */
const thumbnailFrame = async (container: HTMLElement) => {
  for (let i = 0; i < 50; i++) {
    const frame = container.querySelector('iframe')
    if (frame?.srcdoc) {
      return frame
    }
    await act(async () => void (await getClock().tickAsync(20)))
  }
  throw new Error('The card shows no thumbnail')
}

describe('FileCard with a DOCX', () => {
  beforeAll(async () => {
    // Under Bun mammoth resolves to its Node build, which cannot read an ArrayBuffer; the app ships its browser build.
    const browser = await bundleForBrowser<typeof docxToHtmlModule>(
      join(import.meta.dir, '../../files/transformers/docx-to-html.ts'),
    )
    spyOn(docxToHtmlModule, 'docxToHtml').mockImplementation(browser.docxToHtml)
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

    const frame = await thumbnailFrame(container)
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.title).toBe('report.docx')
    expectSampleDocxPreview(frame.srcdoc)
  })
})
