/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearImageSupportCache, getCachedImageSupport, setCachedImageSupport } from '@/ai/image-support'
import { buildAttachmentPart } from '@/lib/attachments'
import { getClock } from '@/testing-library'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { AttachmentData, Model, ThunderboltUIMessage } from '@/types'
import type { ImageSupport } from '@shared/defaults/models'
import { focusManager } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { isImageAttachment, useImageSupportCheck } from './use-image-support-check'

const model = {
  id: 'm1',
  name: 'Local VLM',
  provider: 'custom',
  model: 'llava',
  url: 'http://localhost:11434/v1',
} as Model

const attachment = (mimeType: string): AttachmentData => ({ localFileId: mimeType, filename: 'file', mimeType })
const image = attachment('image/jpeg')

/** A thread whose one user message carried an image. */
const threadWithImage = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'look' }, buildAttachmentPart(image)] },
] as ThunderboltUIMessage[]

const flush = () =>
  act(async () => {
    await getClock().runAllAsync()
  })

/** A detect call whose verdict the test settles by hand. */
const deferredDetect = () => {
  const settle: { resolve?: (support: ImageSupport) => void; reject?: (error: Error) => void } = {}
  const detect = mock(
    () =>
      new Promise<ImageSupport>((resolve, reject) => {
        settle.resolve = resolve
        settle.reject = reject
      }),
  )
  return { detect, settle }
}

const renderCheck = (options: Partial<Parameters<typeof useImageSupportCheck>[0]>) =>
  renderHook(() => useImageSupportCheck({ model, attachments: [image], messages: [], enabled: true, ...options }), {
    wrapper: createQueryTestWrapper(),
  })

describe('isImageAttachment', () => {
  it('matches images sent as raw bytes', () => {
    expect(isImageAttachment(attachment('image/png'))).toBe(true)
    expect(isImageAttachment(attachment('image/webp'))).toBe(true)
  })

  it('ignores documents and text-delivered files', () => {
    expect(isImageAttachment(attachment('application/pdf'))).toBe(false)
    expect(isImageAttachment(attachment('text/plain'))).toBe(false)
  })
})

describe('useImageSupportCheck', () => {
  beforeEach(() => {
    clearImageSupportCache()
  })

  afterEach(() => {
    cleanup()
  })

  it('does nothing without an image in the draft or the thread', () => {
    const { detect } = deferredDetect()
    const { result } = renderCheck({ attachments: [attachment('application/pdf')], detect })
    expect(result.current.notice).toBeUndefined()
    expect(detect).not.toHaveBeenCalled()
  })

  it('does nothing for agents that deliver files themselves', () => {
    const { detect } = deferredDetect()
    const { result } = renderCheck({ enabled: false, detect })
    expect(result.current.notice).toBeUndefined()
    expect(detect).not.toHaveBeenCalled()
  })

  it('holds the send while checking, then clears it for a model that reads images', async () => {
    const { detect, settle } = deferredDetect()
    const { result } = renderCheck({ detect })
    await flush()
    expect(result.current.notice).toBe('checking')
    expect(detect).toHaveBeenCalledTimes(1)

    settle.resolve?.('supported')
    await flush()
    expect(result.current.notice).toBeUndefined()
  })

  it('answers immediately from this device’s cache', () => {
    setCachedImageSupport(model, 'unsupported')
    const { detect } = deferredDetect()
    const { result } = renderCheck({ detect })
    expect(result.current.notice).toBe('unsupported')
    expect(detect).not.toHaveBeenCalled()
  })

  it('lets the send go ahead when the check can’t reach a verdict', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const { detect, settle } = deferredDetect()
    const { result } = renderCheck({ detect })
    await flush()

    settle.reject?.(new Error('Probe failed with status 401'))
    await flush()
    expect(result.current.notice).toBeUndefined()
    warn.mockRestore()
  })

  it('doesn’t re-run a failed check when the window regains focus', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const detect = mock(async (): Promise<ImageSupport> => {
      throw new Error('Probe failed with status 500')
    })
    renderCheck({ detect })
    await flush()
    expect(detect).toHaveBeenCalledTimes(1)

    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await flush()
    expect(detect).toHaveBeenCalledTimes(1)
    focusManager.setFocused(undefined)
    warn.mockRestore()
  })

  describe('thread history', () => {
    it('checks a model when only earlier messages carry images', async () => {
      const { detect } = deferredDetect()
      const { result } = renderCheck({ attachments: [], messages: threadWithImage, detect })
      await flush()
      expect(detect).toHaveBeenCalledTimes(1)
      expect(result.current.notice).toBe('checking')
    })

    it('doesn’t block a text-only send for a model that can’t read the earlier images', () => {
      setCachedImageSupport(model, 'unsupported')
      const { result } = renderCheck({ attachments: [], messages: threadWithImage })
      expect(result.current.notice).toBeUndefined()
    })
  })

  describe('try anyway', () => {
    it('lets the user overrule a detected verdict, and remembers it', async () => {
      setCachedImageSupport(model, 'unsupported')
      const { result } = renderCheck({})
      expect(result.current.notice).toBe('unsupported')

      act(() => {
        result.current.tryAnyway?.()
      })
      await flush()
      expect(result.current.notice).toBeUndefined()
      expect(getCachedImageSupport(model)).toBe('supported')
    })

    it('isn’t offered when a fixed rule rules images out', () => {
      const glm53 = { id: 'glm', name: 'GLM 5.3', provider: 'tinfoil', model: 'glm-5-3', url: null } as Model
      const { result } = renderCheck({ model: glm53 })
      expect(result.current.notice).toBe('unsupported')
      expect(result.current.tryAnyway).toBeUndefined()
    })
  })
})
