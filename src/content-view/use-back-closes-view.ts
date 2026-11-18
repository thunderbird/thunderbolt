/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type RefObject, useEffect, useEffectEvent, useRef } from 'react'

type ViewHistoryState = { contentViewOpen?: boolean } | null

const isViewEntry = () => (window.history.state as ViewHistoryState)?.contentViewOpen === true

const pushViewEntry = () => window.history.pushState({ ...window.history.state, contentViewOpen: true }, '')

/** Leaves the view's entry, marking the traversal as ours so its `popstate` is not taken for the user's Back. */
const stepBack = (steppingBack: RefObject<boolean>) => {
  steppingBack.current = true
  window.history.back()
}

/**
 * While `open`, keeps a history entry for the view on top of the route's own, so Back closes the view instead of
 * leaving the route. That covers the browser's Back and Android's button and gesture, which go back in the WebView's
 * history. The entry copies the route's URL and router state, so the router does not see popping it as a navigation.
 *
 * When the view closes some other way (its close button, Escape), the entry is popped, so the next Back does what it
 * did before the view opened. Reaching an entry whose view is closed (one a route change left buried, or one Back
 * left in the forward history) steps back over it, so no Back or Forward press is spent on it.
 */
export const useBackClosesView = (open: boolean, onBack: () => void) => {
  const steppingBack = useRef(false)

  const onPopState = useEffectEvent(() => {
    if (steppingBack.current) {
      steppingBack.current = false
      // Reopened before that Back landed, so the new view needs its own entry.
      if (open) {
        pushViewEntry()
      }
      return
    }
    if (open) {
      onBack()
      return
    }
    // shortcut: this always steps back, so Forward cannot pass a buried entry; track the direction if that matters.
    if (isViewEntry()) {
      stepBack(steppingBack)
    }
  })

  useEffect(() => {
    const listener = () => onPopState()
    window.addEventListener('popstate', listener)
    return () => window.removeEventListener('popstate', listener)
  }, [])

  useEffect(() => {
    if (!open) {
      // Popped here and not in a cleanup, which StrictMode runs on a view that stays open.
      // This also clears an entry left by a reload.
      if (isViewEntry() && !steppingBack.current) {
        stepBack(steppingBack)
      }
      return
    }
    // An entry already on top is reused, so a remount never stacks a second one.
    if (!isViewEntry()) {
      pushViewEntry()
    }
  }, [open])
}
