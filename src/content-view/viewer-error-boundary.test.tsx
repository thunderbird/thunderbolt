/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from 'bun:test'
import { Suspense, useState } from 'react'
import * as attachmentStorage from '@/lib/file-blob-storage'
import { getClock } from '@/testing-library'
import { ContentViewProvider } from './context'
import { retryableLazy } from './retryable-lazy'
import { ViewerErrorBoundary } from './viewer-error-boundary'
import { LocalViewerLoadFailure } from './viewer-load-failure'

const flush = () => act(async () => void (await getClock().tickAsync(20)))

const Broken = () => {
  throw new Error('Unable to preload CSS for /assets/pdf-sidebar-viewer.css')
}

const Viewer = ({ fileId, broken }: { fileId: string; broken: boolean }) => (
  <ViewerErrorBoundary key={fileId} fallback={<p>{`fallback ${fileId}`}</p>}>
    {broken ? <Broken /> : <p>{`viewer ${fileId}`}</p>}
  </ViewerErrorBoundary>
)

describe('ViewerErrorBoundary', () => {
  let consoleError: Mock<typeof console.error>

  beforeEach(() => {
    consoleError = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    consoleError.mockRestore()
  })

  it('shows the fallback in place of a viewer that throws', () => {
    render(<Viewer fileId="file-a" broken />)

    expect(screen.getByText('fallback file-a')).toBeInTheDocument()
  })

  it('starts fresh on the next file', () => {
    const { rerender } = render(<Viewer fileId="file-a" broken />)

    rerender(<Viewer fileId="file-b" broken={false} />)

    expect(screen.getByText('viewer file-b')).toBeInTheDocument()
    expect(screen.queryByText(/fallback/)).toBeNull()
  })
})

describe('LocalViewerLoadFailure', () => {
  let getAttachment: Mock<typeof attachmentStorage.getAttachment>

  beforeEach(() => {
    const blob = new Blob(['bytes'], { type: 'application/octet-stream' })
    getAttachment = spyOn(attachmentStorage, 'getAttachment').mockImplementation(async (id) => ({
      id,
      filename: 'report.docx',
      mimeType: blob.type,
      size: blob.size,
      createdAt: 0,
      blob,
    }))
  })

  afterEach(() => {
    cleanup()
    getAttachment.mockRestore()
  })

  it("says the preview couldn't load and enables Download", async () => {
    render(
      <ContentViewProvider trackEvent={mock()}>
        <LocalViewerLoadFailure fileId="file-a" fileName="report.docx" onRetry={mock()} />
      </ContentViewProvider>,
    )
    await flush()

    expect(screen.getByText("The preview couldn't load")).toBeInTheDocument()
    expect(screen.getByText('Try again, or download the file.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled()
    expect(getAttachment).toHaveBeenCalledWith('file-a')
  })

  describe('once the viewer loads again', () => {
    /** The side view's wiring around a viewer whose first import fails, as on a broken network, and later ones load. */
    const panelWithBrokenFirstLoad = () => {
      const load = mock(async () => ({ default: ({ fileId }: { fileId: string }) => <p>{`viewer ${fileId}`}</p> }))
      load.mockImplementationOnce(async () => {
        throw new Error('Failed to fetch dynamically imported module')
      })
      const lazyViewer = retryableLazy(load)
      const Panel = () => {
        const [attempt, setAttempt] = useState(0)
        const LazyViewer = lazyViewer()
        return (
          <ContentViewProvider trackEvent={mock()}>
            <ViewerErrorBoundary
              key={`file-a:${attempt}`}
              fallback={
                <LocalViewerLoadFailure
                  fileId="file-a"
                  fileName="report.docx"
                  onRetry={() => setAttempt((count) => count + 1)}
                />
              }
            >
              <Suspense fallback={<p>loading</p>}>
                <LazyViewer fileId="file-a" />
              </Suspense>
            </ViewerErrorBoundary>
          </ContentViewProvider>
        )
      }
      return { load, Panel }
    }

    beforeEach(() => {
      spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => mock.restore())

    it('shows the viewer after Try again', async () => {
      const { load, Panel } = panelWithBrokenFirstLoad()
      render(<Panel />)
      await flush()
      expect(screen.getByText("The preview couldn't load")).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await flush()

      expect(screen.getByText('viewer file-a')).toBeInTheDocument()
      expect(screen.queryByText("The preview couldn't load")).toBeNull()
      expect(load).toHaveBeenCalledTimes(2)
    })

    it('shows the viewer when the file is opened again', async () => {
      const { Panel } = panelWithBrokenFirstLoad()
      render(<Panel />)
      await flush()
      expect(screen.getByText("The preview couldn't load")).toBeInTheDocument()
      cleanup()

      render(<Panel />)
      await flush()

      expect(screen.getByText('viewer file-a')).toBeInTheDocument()
    })
  })
})
