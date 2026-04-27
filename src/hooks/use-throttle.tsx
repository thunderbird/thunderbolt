/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

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
 * Hook that returns a throttled callback
 * @param callback - The callback to throttle
 * @param interval - The minimum time in milliseconds between calls
 * @returns The throttled callback
 */
export const useThrottledCallback = <T extends (...args: any[]) => any>(
  callback: T,
  interval: number,
): ((...args: Parameters<T>) => void) => {
  const lastCallTime = useRef<number>(0)
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const onCallback = useEffectEvent(callback)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return useCallback(
    (...args: Parameters<T>) => {
      const now = Date.now()
      const timeSinceLastCall = now - lastCallTime.current

      if (timeSinceLastCall >= interval) {
        // Enough time has passed, call immediately
        lastCallTime.current = now
        onCallback(...args)
      } else {
        // Not enough time has passed, schedule a call
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }

        timeoutRef.current = setTimeout(() => {
          lastCallTime.current = Date.now()
          onCallback(...args)
        }, interval - timeSinceLastCall)
      }
    },
    [interval, onCallback],
  )
}
