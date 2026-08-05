/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type MouseEvent, type TouchEvent, useCallback, useEffect, useRef } from 'react'

const longPressDuration = 500
// Native contextmenu follows a touch long-press immediately on platforms that
// emit it. Bound the suppression so a platform that emits no contextmenu can
// never leave a later mouse right-click suppressed indefinitely.
const contextMenuSuppressionDuration = 1000

type UseLongPressOptions = {
  duration?: number
  onPressChange?: (isPressing: boolean) => void
}

/**
 * Returns event handlers that trigger a callback after a sustained press or context-menu request.
 * Cancels if the touch moves beyond a small threshold or ends early.
 */
export const useLongPress = (
  onLongPress: () => void,
  { duration = longPressDuration, onPressChange }: UseLongPressOptions = {},
) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressContextMenuUntilRef = useRef(0)
  const startPos = useRef<{ x: number; y: number } | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    startPos.current = null
    onPressChange?.(false)
  }, [onPressChange])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  const onTouchStart = useCallback(
    (e: TouchEvent) => {
      clear()
      suppressContextMenuUntilRef.current = 0
      if (e.touches.length !== 1) {
        return
      }
      const touch = e.touches[0]
      if (!touch) {
        return
      }
      onPressChange?.(true)
      startPos.current = { x: touch.clientX, y: touch.clientY }
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        startPos.current = null
        suppressContextMenuUntilRef.current = Date.now() + contextMenuSuppressionDuration
        onPressChange?.(false)
        onLongPress()
      }, duration)
    },
    [clear, duration, onLongPress, onPressChange],
  )

  const onTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!startPos.current || timerRef.current === null) {
        return
      }
      if (e.touches.length !== 1) {
        clear()
        return
      }
      const touch = e.touches[0]
      if (!touch) {
        clear()
        return
      }
      const dx = touch.clientX - startPos.current.x
      const dy = touch.clientY - startPos.current.y
      if (dx * dx + dy * dy > 100) {
        clear()
      }
    },
    [clear],
  )

  const onTouchEnd = useCallback(() => clear(), [clear])
  const onTouchCancel = useCallback(() => {
    clear()
    suppressContextMenuUntilRef.current = 0
  }, [clear])

  const onContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault()
      clear()
      if (suppressContextMenuUntilRef.current > Date.now()) {
        suppressContextMenuUntilRef.current = 0
        return
      }
      suppressContextMenuUntilRef.current = 0
      onLongPress()
    },
    [clear, onLongPress],
  )

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
    onContextMenu,
  }
}
