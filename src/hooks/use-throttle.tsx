import { useCallback, useEffect, useRef, useState } from 'react'

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
  const callbackRef = useRef(callback)
  const lastCallTime = useRef<number>(0)
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)

  // Keep callback ref up to date
  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

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
        callbackRef.current(...args)
      } else {
        // Not enough time has passed, schedule a call
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }

        timeoutRef.current = setTimeout(() => {
          lastCallTime.current = Date.now()
          callbackRef.current(...args)
        }, interval - timeSinceLastCall)
      }
    },
    [interval],
  )
}
