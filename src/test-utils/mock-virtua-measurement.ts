/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Make virtua's `Virtualizer` render rows in happy-dom, which has no layout
 * engine: every element measures 0px, so virtua sees an empty viewport and
 * mounts nothing. Mirrors virtua's own test setup — patches
 * `HTMLElement.prototype.offsetParent` (virtua ignores ResizeObserver entries
 * whose target has no offsetParent) and replaces `ResizeObserver` with a mock
 * that reports `viewportHeight` for the scroll container (virtua observes it
 * first) and `itemHeight` for every row. Returns a restore function.
 *
 * @example
 * const restore = mockVirtuaMeasurement()
 * // ...render + assertions...
 * restore()
 */
export const mockVirtuaMeasurement = ({ viewportHeight = 800, itemHeight = 40 } = {}): (() => void) => {
  const originalResizeObserver = globalThis.ResizeObserver
  const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')

  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentNode
    },
  })

  const makeEntry = (target: Element, height: number): ResizeObserverEntry =>
    ({
      target,
      contentRect: { top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0, width: 300, height, toJSON: () => ({}) },
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    }) as unknown as ResizeObserverEntry

  class MockResizeObserver {
    // Virtua observes the scroll container before any row, so the first
    // observed element per observer instance gets the viewport height.
    private isFirstObserve = true
    private readonly callback: ResizeObserverCallback

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }

    observe(target: Element) {
      const height = this.isFirstObserve ? viewportHeight : itemHeight
      this.isFirstObserve = false
      this.callback([makeEntry(target, height)], this as unknown as ResizeObserver)
    }

    unobserve() {}
    disconnect() {}
  }

  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
  return () => {
    globalThis.ResizeObserver = originalResizeObserver
    if (originalOffsetParent) {
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent')
    }
  }
}
