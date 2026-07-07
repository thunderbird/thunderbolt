/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type RefObject, useEffect, useState } from 'react'

/**
 * Returns `true` once the element has scrolled on (or near) screen at least once,
 * so an artifact far below the fold doesn't run its scripts until it's reached.
 * It **latches** — once true it stays true, because flipping it back would reload
 * the iframe and lose its in-iframe state.
 */
export const useOnScreen = (ref: RefObject<HTMLElement | null>): boolean => {
  const [everVisible, setEverVisible] = useState(false)

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

  return everVisible
}
