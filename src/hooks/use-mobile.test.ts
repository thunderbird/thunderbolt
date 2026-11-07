/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as platform from '@/lib/platform'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import type { Window as TestWindow } from 'happy-dom'
import { useIsMobile, useIsNativeMobile } from './use-mobile'

const originalWidth = window.innerWidth

/** Resize the real test window so cached media queries receive browser-style changes. */
const resize = (width: number) => {
  act(() => {
    ;(window as unknown as TestWindow).happyDOM.setViewport({ width })
  })
}

afterEach(() => {
  cleanup()
  resize(originalWidth)
})

describe('useIsMobile', () => {
  it('reuses one live query across subscribers and repeated snapshot reads', () => {
    resize(1000)
    const first = renderHook(() => useIsMobile())
    const matchMedia = spyOn(window, 'matchMedia')
    try {
      const second = renderHook(() => useIsMobile())
      for (const width of [767, 768, 390, 1200]) {
        resize(width)
        first.rerender()
        second.rerender()
        expect(first.result.current.isMobile).toBe(width < 768)
        expect(second.result.current.isMobile).toBe(width < 768)
      }
      expect(matchMedia).not.toHaveBeenCalled()
    } finally {
      matchMedia.mockRestore()
    }
  })

  it('removes only the unmounted subscriber and reads the current width when remounted', () => {
    resize(1000)
    const mediaPrototype = Object.getPrototypeOf(window.matchMedia('(max-width: 767px)')) as MediaQueryList
    const addListener = spyOn(mediaPrototype, 'addEventListener')
    const removeListener = spyOn(mediaPrototype, 'removeEventListener')
    try {
      const first = renderHook(() => useIsMobile())
      const second = renderHook(() => useIsMobile())
      expect(addListener).toHaveBeenCalledTimes(2)
      first.unmount()
      expect(removeListener).toHaveBeenCalledTimes(1)

      resize(390)
      expect(second.result.current.isMobile).toBe(true)
      second.unmount()
      expect(removeListener).toHaveBeenCalledTimes(2)

      resize(1000)
      const remounted = renderHook(() => useIsMobile())
      expect(remounted.result.current.isMobile).toBe(false)
      remounted.unmount()
      expect(removeListener).toHaveBeenCalledTimes(3)
    } finally {
      addListener.mockRestore()
      removeListener.mockRestore()
    }
  })

  it('keeps native desktop layout at phone widths', () => {
    const nativeDesktop = spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    try {
      resize(1000)
      const { result } = renderHook(() => useIsMobile())
      resize(390)
      expect(result.current.isMobile).toBe(false)
      resize(768)
      expect(result.current.isMobile).toBe(false)
    } finally {
      nativeDesktop.mockRestore()
    }
  })

  it('requires both the native mobile platform and a mobile viewport for native sizing', () => {
    const nativeMobile = spyOn(platform, 'isMobile').mockReturnValue(true)
    try {
      resize(1000)
      const { result, rerender } = renderHook(() => useIsNativeMobile())
      expect(result.current).toBe(false)
      resize(390)
      expect(result.current).toBe(true)
      nativeMobile.mockReturnValue(false)
      rerender()
      expect(result.current).toBe(false)
    } finally {
      nativeMobile.mockRestore()
    }
  })
})
