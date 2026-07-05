/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type RefObject, useEffect, useState } from 'react'

/**
 * Returns `true` once BOTH conditions have been met: `delayMs` has elapsed since
 * the element mounted, and the element has been on (or near) screen at least
 * once. Used to defer running an artifact's scripts until the app has finished
 * its initial load and the artifact is actually visible — so heavy/animating
 * artifacts don't compete with app startup or run while far below the fold.
 *
 * Visibility **latches**: once activated it stays activated. Toggling it back off
 * would force the iframe to reload (losing its in-iframe state and re-running its
 * scripts), so we activate once and leave it running rather than thrash on scroll.
 */
export const useDeferredVisibility = (ref: RefObject<HTMLElement | null>, delayMs: number): boolean => {
  const [delayElapsed, setDelayElapsed] = useState(false)
  const [everVisible, setEverVisible] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDelayElapsed(true), delayMs)
    return () => clearTimeout(timer)
  }, [delayMs])

  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      // Nothing to observe — assume visible so the artifact can still activate.
      setEverVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setEverVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return delayElapsed && everVisible
}
