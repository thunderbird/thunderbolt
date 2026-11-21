/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { ContentViewProvider, useSideview } from '@/content-view/context'
import * as download from '@/lib/download'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, type Mock, spyOn } from 'bun:test'
import { createElement, type KeyboardEvent, type ReactNode } from 'react'
import type { DocumentBlobState } from './use-document-blob'
import { useDocumentPreviewFrameState } from './use-document-preview-frame-state'

const bytes = new Uint8Array([80, 75, 3, 4])
const ready: DocumentBlobState = {
  status: 'ready',
  blob: new Blob([bytes], { type: 'application/pdf' }),
  blobUrl: 'blob:preview',
  snapshot: null,
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ContentViewProvider, { trackEvent: mock(), children })

const renderFrameState = (state: DocumentBlobState) =>
  renderHook(() => ({ frame: useDocumentPreviewFrameState('report.pdf', state), sideview: useSideview() }), {
    wrapper,
  })

const keyDown = (key: string, defaultPrevented = false) => ({ key, defaultPrevented }) as KeyboardEvent

describe('useDocumentPreviewFrameState', () => {
  let downloadFile: Mock<typeof download.downloadFile>

  beforeEach(() => {
    downloadFile = spyOn(download, 'downloadFile').mockResolvedValue('report.pdf')
  })

  afterEach(() => {
    cleanup()
    downloadFile.mockRestore()
  })

  it('does nothing while the file is not loaded', async () => {
    const { result } = renderFrameState({ status: 'loading' })

    expect(result.current.frame.canDownload).toBe(false)
    await act(() => result.current.frame.handleDownload())
    expect(downloadFile).not.toHaveBeenCalled()
    expect(result.current.frame.saveError).toBeNull()
  })

  it('saves the loaded bytes under the file name and type', async () => {
    const { result } = renderFrameState(ready)

    expect(result.current.frame.canDownload).toBe(true)
    await act(() => result.current.frame.handleDownload())
    expect(downloadFile).toHaveBeenCalledWith({ name: 'report.pdf', contents: bytes, mimeType: 'application/pdf' })
    expect(result.current.frame.saveError).toBeNull()
  })

  it('falls back to a generic type when the blob has none', async () => {
    const { result } = renderFrameState({ ...ready, blob: new Blob([bytes]) })

    await act(() => result.current.frame.handleDownload())
    expect(downloadFile).toHaveBeenCalledWith({
      name: 'report.pdf',
      contents: bytes,
      mimeType: 'application/octet-stream',
    })
  })

  it('says why a save failed, and clears the reason on the next attempt', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    try {
      downloadFile.mockRejectedValueOnce(new Error('No space left on device (os error 28)'))
      const { result } = renderFrameState(ready)

      await act(() => result.current.frame.handleDownload())
      expect(result.current.frame.saveError).toBe('There is not enough free space on this device.')

      await act(() => result.current.frame.handleDownload())
      expect(result.current.frame.saveError).toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('closes the side view on Escape and returns focus to its opener', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { result } = renderFrameState(ready)
    act(() => result.current.sideview.showSideview('document', 'file-1'))
    opener.blur()

    act(() => result.current.frame.handleKeyDown(keyDown('Escape')))

    expect(result.current.sideview.sideviewType).toBeNull()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('leaves the side view open for other keys and for an Escape already handled', () => {
    const { result } = renderFrameState(ready)
    act(() => result.current.sideview.showSideview('document', 'file-1'))

    act(() => result.current.frame.handleKeyDown(keyDown('Enter')))
    act(() => result.current.frame.handleKeyDown(keyDown('Escape', true)))

    expect(result.current.sideview.sideviewType).toBe('document')
  })
})
