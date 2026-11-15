/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { ContentViewProvider } from '@/content-view/context'
import { HttpClientProvider } from '@/contexts'
import { docxMime, pptxMime } from '@/files/transformers'
import * as download from '@/lib/download'
import * as attachmentStorage from '@/lib/file-blob-storage'
import { createClient } from '@/lib/http'
import { expectSampleDocxPreview, waitForPreviewFrame } from '@/test-utils/docx-preview'
import { sampleDocx } from '@/test-utils/sample-docx'
import { parseXmlWithXmlDom } from '@/test-utils/xml-dom-parser'
import { getClock } from '@/testing-library'
import { docxPreviewLimits } from './docx-snapshot'
import { LocalPdfSidebarViewer, PdfSidebarViewer } from './pdf-sidebar-viewer'
import { pptxPreviewLimits } from './pptx-snapshot'

const tick = () => act(async () => void (await getClock().tickAsync(20)))

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
  parseXmlWithXmlDom()
  let docx: Blob

  beforeAll(async () => {
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

    const frame = await waitForPreviewFrame(() => screen.queryByTitle('report.docx'))
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

    const frame = await waitForPreviewFrame(() => screen.queryByTitle('report.docx'))
    expect(frame.getAttribute('sandbox')).toBe('')
    expectSampleDocxPreview(frame.srcdoc)
  })

  test('refuses a document past the size limit, and Download still saves it', async () => {
    const bytes = new Uint8Array(docxPreviewLimits.fileBytes + 1)
    const save = spyOn(download, 'downloadFile').mockResolvedValue('report.docx')
    render(
      <HttpClientProvider httpClient={haystackClient(new Blob([bytes], { type: docxMime }))}>
        <ContentViewProvider trackEvent={mock()}>
          <PdfSidebarViewer fileId="file-2" fileName="report.docx" />
        </ContentViewProvider>
      </HttpClientProvider>,
    )
    for (let i = 0; i < 5; i++) {
      await tick()
    }

    expect(screen.getByText('This document is too large to preview')).toBeInTheDocument()
    expect(screen.queryByTitle('report.docx')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await tick()
    expect(save).toHaveBeenCalledWith({ name: 'report.docx', contents: bytes, mimeType: docxMime })
  })

  test('says a document it cannot read cannot be previewed, and Download still works', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    render(
      <HttpClientProvider httpClient={haystackClient(new Blob(['not a document'], { type: docxMime }))}>
        <ContentViewProvider trackEvent={mock()}>
          <PdfSidebarViewer fileId="file-3" fileName="report.docx" />
        </ContentViewProvider>
      </HttpClientProvider>,
    )
    for (let i = 0; i < 5; i++) {
      await tick()
    }

    expect(screen.getByText("This document can't be previewed")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled()
    expect(logged).toHaveBeenCalledTimes(1)
  })
})

describe('PPTX preview in the side panel', () => {
  afterEach(cleanup)

  test('refuses a deck past the size limit, and Download still saves it', async () => {
    const bytes = new Uint8Array(pptxPreviewLimits.fileBytes + 1)
    const save = spyOn(download, 'downloadFile').mockResolvedValue('review.pptx')
    try {
      render(
        <HttpClientProvider httpClient={haystackClient(new Blob([bytes], { type: pptxMime }))}>
          <ContentViewProvider trackEvent={mock()}>
            <PdfSidebarViewer fileId="deck-1" fileName="review.pptx" />
          </ContentViewProvider>
        </HttpClientProvider>,
      )
      for (let i = 0; i < 5; i++) {
        await tick()
      }

      expect(screen.getByText('This presentation is too large to preview')).toBeInTheDocument()
      expect(screen.queryByTitle('review.pptx')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
      await tick()
      expect(save).toHaveBeenCalledWith({ name: 'review.pptx', contents: bytes, mimeType: pptxMime })
    } finally {
      save.mockRestore()
    }
  })

  test('says a deck it cannot read cannot be previewed, and Download still works', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <HttpClientProvider httpClient={haystackClient(new Blob(['not a deck'], { type: pptxMime }))}>
          <ContentViewProvider trackEvent={mock()}>
            <PdfSidebarViewer fileId="deck-2" fileName="review.pptx" />
          </ContentViewProvider>
        </HttpClientProvider>,
      )
      for (let i = 0; i < 5; i++) {
        await tick()
      }

      expect(screen.getByText("This presentation can't be previewed")).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled()
    } finally {
      logged.mockRestore()
    }
  })
})
