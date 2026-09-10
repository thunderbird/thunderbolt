/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whether the shared floating header has anything to show on this route.
 *
 * Almost everything in `Header` is gated on being a `/chats` route — the agent
 * selector, the project badge — so on an app route it renders an empty bar the
 * height of `--header-inset`, plus its scrim, above an app that then can't reach
 * the top of the window. What's left is platform chrome: the back/forward arrows
 * and the frameless drag region on the desktop app, and the sidebar toggle on a
 * collapsed macOS window.
 *
 * So the header appears where it earns its space. Removing it outright was the
 * first thing tried here and it cost exactly those controls, which is what put
 * them back; deciding per route *and* platform is what keeps both true.
 *
 * Two callers, one answer: `main-layout` decides whether to render it, and the
 * app route decides whether to inset for it. If those two ever disagree the app
 * either slides under the scrim or floats below a bar that isn't there.
 */
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
