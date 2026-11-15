/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from 'bun:test'
import { HttpClientProvider } from '@/contexts'
import * as attachmentStorage from '@/lib/file-blob-storage'
import { createClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import { buildDocumentSideviewId } from '@/types/citation'
import { ContentViewProvider, useShowSideview } from './context'
import { Sideview } from './sideview'
// Loaded up front, so the side view's lazy imports resolve within the fake clock's ticks.
import '@/components/xlsx-preview'
import '@/widgets/document-result/pdf-sidebar-viewer'

const storedFiles = new Map<string, attachmentStorage.StoredFile>()

const store = (id: string, filename: string, blob: Blob) =>
  storedFiles.set(id, { id, filename, mimeType: blob.type, size: blob.size, createdAt: 0, blob })

/** Opens one file in the side view, the way a file card does. */
const Opener = ({ type, id, fileName }: { type: string; id: string; fileName: string }) => {
  const showSideview = useShowSideview()
  return (
    <button type="button" onClick={() => showSideview?.(type, buildDocumentSideviewId({ fileId: id, fileName }))}>
      {`open ${id}`}
    </button>
  )
}

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => void (await getClock().tickAsync(20)))
  }
}

const httpClient = createClient({
  prefixUrl: 'https://backend.test',
  fetch: async () => new Response(new Blob([new Uint8Array([1, 2, 3])])),
})

/** The side view and a button per file, two files of one name: switching between them is the case under test. */
const renderSideview = (type: string, fileName: string) => {
  render(
    <HttpClientProvider httpClient={httpClient}>
      <ContentViewProvider trackEvent={mock()}>
        <Opener type={type} id="file-a" fileName={fileName} />
        <Opener type={type} id="file-b" fileName={fileName} />
        <Sideview />
      </ContentViewProvider>
    </HttpClientProvider>,
  )
  return async (id: string) => {
    fireEvent.click(screen.getByRole('button', { name: `open ${id}` }))
    await flush()
  }
}

describe('Sideview', () => {
  let getAttachment: Mock<typeof attachmentStorage.getAttachment>
  let objectUrls: Mock<typeof URL.createObjectURL>
  let consoleError: Mock<typeof console.error>

  beforeEach(() => {
    getAttachment = spyOn(attachmentStorage, 'getAttachment').mockImplementation(
      async (id) => storedFiles.get(id) ?? null,
    )
    objectUrls = spyOn(URL, 'createObjectURL')
    consoleError = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    storedFiles.clear()
    getAttachment.mockRestore()
    objectUrls.mockRestore()
    consoleError.mockRestore()
  })

  /** Click Download with the app's saver set to fail. */
  const failDownload = async () => {
    objectUrls.mockImplementationOnce(() => {
      throw new Error('The disk is full.')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await flush()
  }

  // A local file of no previewed type, a remote workbook, and a local workbook too large to preview (the control,
  // keyed before this change): all show the shared frame without loading anything else.
  const cases = [
    { type: 'local-file', fileName: 'notes.txt', blob: () => new Blob(['notes'], { type: 'text/plain' }) },
    { type: 'document', fileName: 'q1.xlsx', blob: () => new Blob(['remote'], { type: 'text/plain' }) },
    { type: 'local-file', fileName: 'budget.xlsx', blob: () => new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]) },
  ]

  it('shows no failed download of one file on the next file of the same name', async () => {
    for (const { type, fileName, blob } of cases) {
      store('file-a', fileName, blob())
      store('file-b', fileName, blob())
      const open = renderSideview(type, fileName)
      await open('file-a')
      await failDownload()
      expect(screen.getByRole('alert').textContent).toBe("Couldn't save: The disk is full.")

      await open('file-b')

      expect(screen.queryByRole('alert')).toBeNull()
      cleanup()
    }
  })

  it('shows no failure of a download still saving when the user switched files', async () => {
    const { promise: bytes, resolve } = Promise.withResolvers<ArrayBuffer>()
    store(
      'file-a',
      'notes.txt',
      Object.assign(new Blob(['notes'], { type: 'text/plain' }), { arrayBuffer: () => bytes }),
    )
    store('file-b', 'notes.txt', new Blob(['other'], { type: 'text/plain' }))
    const open = renderSideview('local-file', 'notes.txt')
    await open('file-a')
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await open('file-b')

    // File A's bytes arrive only now, and its save fails.
    objectUrls.mockImplementationOnce(() => {
      throw new Error('The disk is full.')
    })
    resolve(new ArrayBuffer(5))
    await flush()

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
