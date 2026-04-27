/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useCopyToClipboard } from './use-copy-to-clipboard'

const writeTextMock = mock(() => Promise.resolve())

Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: writeTextMock },
  configurable: true,
})

afterEach(() => {
  cleanup()
  writeTextMock.mockClear()
})

describe('useCopyToClipboard', () => {
  it('starts with isCopied false', () => {
    const { result } = renderHook(() => useCopyToClipboard())
    expect(result.current.isCopied).toBe(false)
  })

  it('writes text to clipboard and sets isCopied to true', async () => {
    const { result } = renderHook(() => useCopyToClipboard())

    await act(async () => {
      await result.current.copy('hello')
    })

    expect(writeTextMock).toHaveBeenCalledWith('hello')
    expect(result.current.isCopied).toBe(true)
  })

  it('resets isCopied after resetMs', async () => {
    const { result } = renderHook(() => useCopyToClipboard(1000))

    await act(async () => {
      await result.current.copy('hello')
    })

    expect(result.current.isCopied).toBe(true)

    await act(async () => {
      await getClock().tickAsync(1000)
    })

    expect(result.current.isCopied).toBe(false)
  })

  it('cleans up timeout on unmount', async () => {
    const { result, unmount } = renderHook(() => useCopyToClipboard())

    await act(async () => {
      await result.current.copy('hello')
    })

    expect(() => unmount()).not.toThrow()
  })
})
