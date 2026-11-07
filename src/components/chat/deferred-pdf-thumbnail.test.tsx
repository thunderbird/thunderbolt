/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as attachmentStorage from '@/lib/file-blob-storage'
import { getClock } from '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn, type Mock } from 'bun:test'
import { FileCard } from './file-card'

const observers: VisibilityObserver[] = []

class VisibilityObserver {
  readonly disconnect = mock()
  readonly rootMargin: string
  private readonly callback: IntersectionObserverCallback
  private target?: Element

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.rootMargin = options?.rootMargin ?? ''
    observers.push(this)
  }

  observe(target: Element) {
    this.target = target
    this.emit(false)
  }

  emit(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting, target: this.target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

const flush = () => act(async () => void (await getClock().runAllAsync()))

describe('deferred PDF thumbnails', () => {
  let originalObserver: typeof IntersectionObserver
  let attachment: Mock<typeof attachmentStorage.getAttachment>

  beforeEach(() => {
    originalObserver = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = VisibilityObserver as unknown as typeof IntersectionObserver
    attachment = spyOn(attachmentStorage, 'getAttachment').mockResolvedValue(null)
  })

  afterEach(() => {
    cleanup()
    globalThis.IntersectionObserver = originalObserver
    observers.length = 0
    attachment.mockRestore()
  })

  it('keeps offscreen file actions usable without reading or decoding the PDF', async () => {
    const onOpen = mock()
    const onRemove = mock()
    const onResend = mock()
    render(
      <FileCard
        localFileId="offscreen-pdf"
        filename="report.pdf"
        mimeType="application/pdf"
        onOpen={onOpen}
        onRemove={onRemove}
        onResend={onResend}
        resendTargets={['text']}
      />,
    )
    await flush()

    expect(observers).toHaveLength(1)
    expect(observers[0].rootMargin).toBe('300px 0px')
    expect(attachment).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('report.pdf'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove report.pdf' }))
    fireEvent.click(screen.getByRole('button', { name: 'Resend as text' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onResend).toHaveBeenCalledWith('text')
  })

  it('loads once near the viewport and retains the preview after scrolling away', async () => {
    const card = <FileCard localFileId="visible-pdf" filename="report.pdf" mimeType="application/pdf" />
    const { rerender, unmount } = render(card)
    await flush()
    expect(attachment).not.toHaveBeenCalled()

    await act(async () => observers[0].emit(true))
    await act(async () => void (await import('./pdf-thumbnail')))
    await flush()
    expect(attachment).toHaveBeenCalledTimes(1)
    expect(attachment).toHaveBeenCalledWith('visible-pdf')
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1)

    await act(async () => observers[0].emit(false))
    rerender(card)
    await flush()
    expect(attachment).toHaveBeenCalledTimes(1)

    unmount()
    expect(observers[0].disconnect).toHaveBeenCalledTimes(2)
  })
})
