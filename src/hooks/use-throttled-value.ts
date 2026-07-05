/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'

/**
 * Returns a copy of `value` that updates at most once per `intervalMs` (trailing
 * edge), always settling on the latest value. Useful for feeding rapidly
 * changing data (e.g. a streaming string) into an expensive sink without
 * re-rendering it on every change.
 */
export const useThrottledValue = <T>(value: T, intervalMs: number): T => {
  const [throttled, setThrottled] = useState(value)
  const latestRef = useRef(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    latestRef.current = value
    if (timerRef.current !== null) {
      return
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setThrottled(latestRef.current)
    }, intervalMs)
  }, [value, intervalMs])

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
    },
    [],
  )

  return throttled
}
