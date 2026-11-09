/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { type FittedWindow, useFitWindowToContent } from './use-fit-window-to-content'

let resize: ((height: number) => void) | null = null
const disconnect = mock(() => {})
const originalResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  resize = null
  disconnect.mockClear()
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resize = (height) =>
        callback([{ borderBoxSize: [{ blockSize: height }] } as unknown as ResizeObserverEntry], this)
    }
    observe() {}
    unobserve() {}
    disconnect = disconnect
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver
})

/** A 2× window at y=1000 whose current outer size is 1360×176 physical pixels. */
const createWindow = () => ({
  scaleFactor: mock(() => Promise.resolve(2)),
  outerPosition: mock(() => Promise.resolve({ x: 100, y: 1000 })),
  outerSize: mock(() => Promise.resolve({ width: 1360, height: 176 })),
  setPosition: mock((_position: unknown) => Promise.resolve()),
  setSize: mock((_size: unknown) => Promise.resolve()),
})

const render = () => {
  const fittedWindow = createWindow()
  const contentRef = { current: document.createElement('form') }
  const hook = renderHook(() => useFitWindowToContent(contentRef, fittedWindow as unknown as FittedWindow))
  return { fittedWindow, ...hook }
}

describe('useFitWindowToContent', () => {
  it('grows upward, keeping the bottom edge in place', async () => {
    const { fittedWindow } = render()

    await act(async () => resize?.(120))

    expect(fittedWindow.setPosition.mock.calls[0][0]).toMatchObject({ x: 100, y: 936 })
    expect(fittedWindow.setSize.mock.calls[0][0]).toMatchObject({ width: 1360, height: 240 })
  })

  it('shrinks downward, keeping the bottom edge in place', async () => {
    const { fittedWindow } = render()

    await act(async () => resize?.(60))

    expect(fittedWindow.setPosition.mock.calls[0][0]).toMatchObject({ x: 100, y: 1056 })
    expect(fittedWindow.setSize.mock.calls[0][0]).toMatchObject({ width: 1360, height: 120 })
  })

  it('leaves the window alone when the height already fits', async () => {
    const { fittedWindow } = render()

    await act(async () => resize?.(88))

    expect(fittedWindow.setPosition).not.toHaveBeenCalled()
    expect(fittedWindow.setSize).not.toHaveBeenCalled()
  })

  it('keeps the bottom edge when the content resizes again mid-fit', async () => {
    // A stateful window whose reads reflect earlier writes. The second resize
    // lands while the first fit has moved the window but not yet resized it,
    // which is when an overlapping fit would read a half-applied move.
    const geometry = { y: 1000, height: 176 }
    const statefulWindow = {
      scaleFactor: async () => 2,
      outerPosition: async () => ({ x: 100, y: geometry.y }),
      outerSize: async () => ({ width: 1360, height: geometry.height }),
      setPosition: async (position: { y: number }) => {
        const isFirstMove = geometry.y === 1000
        geometry.y = position.y
        if (isFirstMove) {
          resize?.(60)
        }
      },
      setSize: async (size: { height: number }) => {
        geometry.height = size.height
      },
    }
    const contentRef = { current: document.createElement('form') }
    renderHook(() => useFitWindowToContent(contentRef, statefulWindow as unknown as FittedWindow))

    await act(async () => {
      resize?.(120)
      await getClock().runAllAsync()
    })

    expect(geometry).toEqual({ y: 1176 - 120, height: 120 })
  })

  it('stops observing on unmount', () => {
    const { unmount } = render()

    unmount()

    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
