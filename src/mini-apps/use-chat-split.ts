/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whether the window is wide enough to show the app and the chat side by side.
 *
 * The split has two floors and they are absolute, not proportional. A percentage
 * minimum is meaningless here: 20% of a 600px window is a 120px chat, which is
 * narrower than its own composer and was the jank in THU-902. So both panels get
 * a pixel minimum, and below their sum the split cannot honour either one.
 *
 * `useSyncExternalStore` over `matchMedia` rather than a resize listener into
 * state: the browser already tracks this, and a stored copy is one that can be
 * wrong for a frame. Same shape as `useIsMobile`.
 */

import { useSyncExternalStore } from 'react'

/**
 * The app's floor. 360px is the content floor `main-layout` uses for the same
 * job, and the create-item container query in `index.css` derives its 840px
 * breakpoint from it — keep the two in step.
 */
export const appPanelMinWidth = 360

/**
 * The chat's floor. Below roughly this the composer, its send button and the
 * model picker stop fitting on one row and the panel starts wrapping onto
 * itself.
 */
export const chatPanelMinWidth = 340

/** Narrower than this and one of the two panels would be below its minimum. */
export const chatSplitFloor = appPanelMinWidth + chatPanelMinWidth

const mql = () => window.matchMedia(`(min-width: ${chatSplitFloor}px)`)

const subscribe = (callback: () => void) => {
  const mediaQuery = mql()
  mediaQuery.addEventListener('change', callback)
  return () => mediaQuery.removeEventListener('change', callback)
}

const getSnapshot = () => mql().matches

/** Server render has no window; assume the split fits and let the client correct it. */
const getServerSnapshot = () => true

export const useChatSplitFits = (): boolean => useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
