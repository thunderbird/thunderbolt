import { type MouseEvent, type TouchEvent, useCallback, useRef } from 'react'

const longPressDuration = 500

/**
 * Returns touch event handlers that trigger a callback after a sustained press.
 * Cancels if the touch moves beyond a small threshold or ends early.
 */
export const useLongPress = (onLongPress: () => void, duration = longPressDuration) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPos = useRef<{ x: number; y: number } | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const onTouchStart = useCallback(
    (e: TouchEvent) => {
      const touch = e.touches[0]
      startPos.current = { x: touch.clientX, y: touch.clientY }
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        onLongPress()
      }, duration)
    },
    [onLongPress, duration],
  )

  const onTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!startPos.current || !timerRef.current) {
        return
      }
      const touch = e.touches[0]
      const dx = touch.clientX - startPos.current.x
      const dy = touch.clientY - startPos.current.y
      if (dx * dx + dy * dy > 100) {
        clear()
      }
    },
    [clear],
  )

  const onTouchEnd = useCallback(() => clear(), [clear])

  const onContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault()
      onLongPress()
    },
    [onLongPress],
  )

  return { onTouchStart, onTouchMove, onTouchEnd, onContextMenu }
}
