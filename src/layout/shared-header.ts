/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Expanded pages own their header; legacy app routes still use platform chrome. */
export const sharedHeaderHasControls = ({
  pathname,
  isMobile,
  isDesktopApp,
}: {
  pathname: string
  isMobile: boolean
  /**
   * `isTauriDesktop()`, passed in rather than read here.
   *
   * Keeps this a pure function of its inputs, which is the difference between
   * testing the rule and mocking a shared module to get at it.
   */
  isDesktopApp: boolean
}): boolean => {
  if (pathname.startsWith('/pages/')) {
    return false
  }
  // The mobile header is a different layout entirely and always carries the
  // sidebar toggle. (Mini Apps don't render below the breakpoint anyway — the
  // route shows a size notice — but the header still has to be right there.)
  if (isMobile) {
    return true
  }
  if (!pathname.startsWith('/apps/')) {
    return true
  }
  // On the desktop app: back/forward, and the drag surface a frameless window
  // has nowhere else to get. On web: nothing at all, so nothing is drawn.
  return isDesktopApp
}
