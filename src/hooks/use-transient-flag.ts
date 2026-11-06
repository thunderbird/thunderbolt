/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A boolean that flips true, then falls back to false on its own.
 *
 * For the "flash a tick, then go back to the normal icon" pattern. Extracted
 * because the second copy of it was written without the falling edge: the
 * artifact download button set its flag and never cleared it, so after one
 * download the icon stayed a tick for the life of the component and the next
 * download gave no feedback at all.
 *
 * Retriggering restarts the window rather than stacking timers, and the pending
 * timer is cleared on unmount so a late fire can't set state on a component
 * that has gone.
 */
export const useTransientFlag = (resetMs = 2000) => {
  const [isSet, setIsSet] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    },
    [],
  )

  const flag = useCallback(() => {
    setIsSet(true)
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = setTimeout(() => setIsSet(false), resetMs)
  }, [resetMs])

  return { isSet, flag }
}
