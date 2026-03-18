import { useCallback, useEffect, useRef } from 'react'

type UseLongPressOptions = {
  delay?: number
  onLongPress: () => void
}

/**
 * Detects long press (touch hold) gestures.
 * Returns event handlers to spread onto the target element.
 * Cancels on touch move (scroll) to avoid false triggers.
 */
export const useLongPress = ({ delay = 500, onLongPress }: UseLongPressOptions) => {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onLongPressRef = useRef(onLongPress)
  const isMountedRef = useRef(true)

  useEffect(() => {
    onLongPressRef.current = onLongPress
  })

  useEffect(() => {
    return () => {
      isMountedRef.current = false
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const start = useCallback(() => {
    timeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        onLongPressRef.current()
      }
    }, delay)
  }, [delay])

  const clear = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
  }, [])

  return {
    onTouchStart: start,
    onTouchEnd: clear,
    onTouchMove: clear,
  }
}
