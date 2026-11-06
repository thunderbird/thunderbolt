/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** happy-dom exposes its control API on `window.happyDOM`, but the global
 *  registrator doesn't augment the DOM lib's `Window`. Declare the one method
 *  these helpers drive so `tsc --noEmit` stays green. */
declare global {
  // Global augmentation requires declaration merging, which only `interface` supports.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    happyDOM?: { setViewport: (viewport: { width: number }) => void }
  }
}

/** happy-dom's default viewport width (matches the bun test preload). */
export const desktopWidth = 1024

/** Width comfortably below the 768px breakpoint `useIsMobile` reads. */
export const mobileWidth = 375

/** Resize happy-dom's viewport; media queries (and `useIsMobile`) follow. */
export const setViewport = (width: number) => window.happyDOM?.setViewport({ width })

/**
 * Narrows the viewport so `useIsMobile` (a `matchMedia` reader) reports
 * mobile. Pair with `restoreViewport()` in `afterEach` — the viewport is
 * worker-global and leaks into later test files otherwise.
 */
export const forceMobileViewport = () => setViewport(mobileWidth)

/** Restores happy-dom's default (desktop) viewport. */
export const restoreViewport = () => setViewport(desktopWidth)
