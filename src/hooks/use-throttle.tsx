/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Hook that throttles a value
 * @param value - The value to throttle
 * @param interval - The minimum time in milliseconds between updates
 * @returns The throttled value
 */
export const useThrottle = <T,>(value: T, interval: number): T => {
  const [throttledValue, setThrottledValue] = useState<T>(value)
  const lastUpdated = useRef<number>(0)
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)

  useEffect(() => {
    const now = Date.now()
    const timeSinceLastUpdate = now - lastUpdated.current

    if (timeSinceLastUpdate >= interval) {
      // Enough time has passed, update immediately
      lastUpdated.current = now
      setThrottledValue(value)
    } else {
      // Not enough time has passed, schedule an update
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }

      timeoutRef.current = setTimeout(() => {
        lastUpdated.current = Date.now()
        setThrottledValue(value)
      }, interval - timeSinceLastUpdate)
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [value, interval])

  return throttledValue
}

/**
 * Hook that returns a throttled callback.
 * @param callback - The callback to throttle
 * @param interval - The minimum time in milliseconds between calls
 * @returns The throttled callback, augmented with:
 *   - `cancel()` — drop a pending trailing call (e.g. when the source has ended
 *     and a later call would clobber fresher state).
 *   - `flush()` — run the pending trailing call *now* with its latest args and
 *     clear the timer; no-op when nothing is pending. Use when a trailing call
 *     must land deterministically instead of waiting out the throttle window.
 */
export const useThrottledCallback = <T extends (...args: any[]) => any>(
  callback: T,
  interval: number,
): ((...args: Parameters<T>) => void) & { cancel: () => void; flush: () => void } => {
  const lastCallTime = useRef<number>(0)
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const pendingArgsRef = useRef<Parameters<T> | undefined>(undefined)
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return useMemo(() => {
    const throttled = (...args: Parameters<T>) => {
      const now = Date.now()
      const timeSinceLastCall = now - lastCallTime.current

      if (timeSinceLastCall >= interval) {
        // Enough time has passed, call immediately
        lastCallTime.current = now
        callbackRef.current(...args)
      } else {
        // Not enough time has passed, schedule a trailing call with the latest args
        pendingArgsRef.current = args
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }

        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = undefined
          pendingArgsRef.current = undefined
          lastCallTime.current = Date.now()
          callbackRef.current(...args)
        }, interval - timeSinceLastCall)
      }
    }

    throttled.cancel = () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = undefined
      }
      pendingArgsRef.current = undefined
    }

    throttled.flush = () => {
      if (!timeoutRef.current) {
        return
      }
      clearTimeout(timeoutRef.current)
      timeoutRef.current = undefined
      const args = pendingArgsRef.current
      pendingArgsRef.current = undefined
      lastCallTime.current = Date.now()
      if (args) {
        callbackRef.current(...args)
      }
    }

    return throttled
  }, [interval])
}
