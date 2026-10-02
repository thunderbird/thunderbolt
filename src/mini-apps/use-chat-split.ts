/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whether there is room to show the app and the chat side by side.
 *
 * The split has two floors and they are absolute, not proportional. A percentage
 * minimum is meaningless here: 20% of a 600px window is a 120px chat, narrower
 * than its own composer, which was the jank in THU-902. So both panels get a
 * pixel minimum, and below their sum the split cannot honour either one.
 *
 * Measured on the **element**, not the window. `matchMedia` was wrong in a way
 * that a wide viewport hides: the route renders inside `main-layout`'s content
 * panel, with the nav sidebar beside it and a content-view aside possibly beyond
 * that, so the space actually available to the split is a good deal narrower
 * than the window. At an 800px browser width with the sidebar open, the window
 * cleared the floor while the app had barely 500px — so the Chat button stayed
 * lit and opening it produced exactly the squeezed split the floors exist to
 * prevent.
 */

import { useEffect, useState } from 'react'

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

/**
 * Observe `element` and report whether the split fits inside it.
 *
 * `null` — before the ref attaches, or on a server render — answers `true` so
 * the first paint is the ordinary layout rather than a flash of the narrow one.
 * The observer corrects it on the same frame it attaches.
 */
export const useChatSplitFits = (element: HTMLElement | null): boolean => {
  const [fits, setFits] = useState(true)

  useEffect(() => {
    if (!element) {
      return
    }
    // `ResizeObserver` rather than a window listener: the element narrows when
    // the sidebar expands or an aside opens, neither of which resizes the window.
    const observer = new ResizeObserver(([entry]) => {
      setFits(entry.contentRect.width >= chatSplitFloor)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return fits
}
