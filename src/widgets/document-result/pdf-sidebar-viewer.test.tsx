/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { ContentViewProvider } from '@/content-view/context'
import { HttpClientProvider } from '@/contexts'
import { docxMime } from '@/files/transformers'
import * as docxToHtmlModule from '@/files/transformers/docx-to-html'
import * as attachmentStorage from '@/lib/file-blob-storage'
import { createClient } from '@/lib/http'
import { bundleForBrowser } from '@/test-utils/bundle-for-browser'
import { expectSampleDocxPreview } from '@/test-utils/expect-sample-docx-preview'
import { sampleDocx } from '@/test-utils/sample-docx'
import { getClock } from '@/testing-library'
import { LocalPdfSidebarViewer, PdfSidebarViewer } from './pdf-sidebar-viewer'

const tick = () => act(async () => void (await getClock().tickAsync(20)))

/** Ticks until the preview frame named `title` holds its document, since the renderer reads the file asynchronously. */
const previewFrame = async (title: string) => {
  for (let i = 0; i < 50; i++) {
    const frame = screen.queryByTitle(title)
    if (frame instanceof HTMLIFrameElement && frame.srcdoc) {
      return frame
    }
    await tick()
  }
  throw new Error(`No preview frame named ${title}`)
}

const haystackClient = (blob: Blob) =>
  createClient({ prefixUrl: 'https://backend.test', fetch: async () => new Response(blob) })

describe('LocalPdfSidebarViewer', () => {
  afterEach(cleanup)

  test('names the download button', () => {
    render(
      <ContentViewProvider trackEvent={mock()}>
        <LocalPdfSidebarViewer localFileId="missing" fileName="sample.pdf" />
      </ContentViewProvider>,
    )

    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
  })
})

describe('PdfSidebarViewer', () => {
  afterEach(cleanup)

  test('offers Download for a workbook from Haystack, which has no grid here', async () => {
    render(
      <HttpClientProvider httpClient={haystackClient(new Blob([new Uint8Array([1, 2, 3])]))}>
        <ContentViewProvider trackEvent={mock()}>
          <PdfSidebarViewer fileId="file-1" fileName="q1.xlsx" />
        </ContentViewProvider>
      </HttpClientProvider>,
    )
    for (let i = 0; i < 5; i++) {
      await tick()
    }

    expect(
      screen.getByText('Preview not available for this file type. Use the download button to view it.'),
    ).toBeInTheDocument()
  })
})

describe('DOCX preview in the side panel', () => {
  let docx: Blob

  beforeAll(async () => {
    // Under Bun mammoth resolves to its Node build, which cannot read an ArrayBuffer; the app ships its browser build.
    const browser = await bundleForBrowser<typeof docxToHtmlModule>(
      join(import.meta.dir, '../../files/transformers/docx-to-html.ts'),
    )
    spyOn(docxToHtmlModule, 'docxToHtml').mockImplementation(browser.docxToHtml)
    docx = await sampleDocx()
    spyOn(attachmentStorage, 'getAttachment').mockResolvedValue({
      id: 'local-1',
      filename: 'report.docx',
      mimeType: docxMime,
      size: docx.size,
      createdAt: 0,
      blob: docx,
    })
  })

  afterEach(cleanup)
  afterAll(() => mock.restore())

  test('shows an attached document with its headings, lists, table and picture', async () => {
    render(
      <ContentViewProvider trackEvent={mock()}>
        <LocalPdfSidebarViewer localFileId="local-1" fileName="report.docx" />
      </ContentViewProvider>,
    )

    const frame = await previewFrame('report.docx')
    expect(frame.getAttribute('sandbox')).toBe('')
    expectSampleDocxPreview(frame.srcdoc)
  })

  test('shows a document opened from a document search result', async () => {
    render(
      <HttpClientProvider httpClient={haystackClient(docx)}>
        <ContentViewProvider trackEvent={mock()}>
          <PdfSidebarViewer fileId="file-1" fileName="report.docx" />
        </ContentViewProvider>
      </HttpClientProvider>,
    )

    const frame = await previewFrame('report.docx')
    expect(frame.getAttribute('sandbox')).toBe('')
    expectSampleDocxPreview(frame.srcdoc)
  })
})
