/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Replace the global `IntersectionObserver` with a mock that reports the given
 * intersection state synchronously when an element is observed. happy-dom ships
 * a non-functional stub that never fires, so components gated on visibility need
 * this to reach their "on screen" state in tests. Returns a restore function.
 *
 * @example
 * const restore = mockIntersectionObserver(true)
 * // ...render + assertions...
 * restore()
 */
export const mockIntersectionObserver = (isIntersecting = true): (() => void) => {
  const original = globalThis.IntersectionObserver

  class MockIntersectionObserver {
    root: Element | null = null
    rootMargin = ''
    thresholds: ReadonlyArray<number> = []
    private readonly callback: IntersectionObserverCallback

    // Accept the real 2-arg signature (callback, options) so call sites like
    // `new IntersectionObserver(cb, { rootMargin })` aren't flagged as passing a superfluous arg.
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.callback = callback
      this.rootMargin = options?.rootMargin ?? ''
    }

    observe(target: Element) {
      this.callback([{ isIntersecting, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }

    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }

  globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver
  return () => {
    globalThis.IntersectionObserver = original
  }
}
