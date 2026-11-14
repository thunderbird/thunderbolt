/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ContentViewProvider } from '@/content-view/context'
import { HttpClientProvider } from '@/contexts'
import { createClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import { LocalPdfSidebarViewer, PdfSidebarViewer } from './pdf-sidebar-viewer'

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
    const httpClient = createClient({
      prefixUrl: 'https://backend.test',
      fetch: async () => new Response(new Blob([new Uint8Array([1, 2, 3])])),
    })
    render(
      <HttpClientProvider httpClient={httpClient}>
        <ContentViewProvider trackEvent={mock()}>
          <PdfSidebarViewer fileId="file-1" fileName="q1.xlsx" />
        </ContentViewProvider>
      </HttpClientProvider>,
    )
    for (let i = 0; i < 5; i++) {
      await act(async () => void (await getClock().tickAsync(20)))
    }

    expect(
      screen.getByText('Preview not available for this file type. Use the download button to view it.'),
    ).toBeInTheDocument()
  })
})
