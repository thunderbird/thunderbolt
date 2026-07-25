/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type MouseEvent, type TouchEvent, useCallback, useEffect, useRef } from 'react'

const longPressDuration = 500

/**
 * Returns event handlers that trigger a callback after a sustained press or context-menu request.
 * Cancels if the touch moves beyond a small threshold or ends early.
 */
export const useLongPress = (onLongPress: () => void, duration = longPressDuration) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firedRef = useRef(false)
  const startPos = useRef<{ x: number; y: number } | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    startPos.current = null
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  const onTouchStart = useCallback(
    (e: TouchEvent) => {
      clear()
      firedRef.current = false
      const touch = e.touches[0]
      startPos.current = { x: touch.clientX, y: touch.clientY }
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        startPos.current = null
        firedRef.current = true
        onLongPress()
      }, duration)
    },
    [clear, onLongPress, duration],
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
      clear()
      if (firedRef.current) {
        firedRef.current = false
        return
      }
      onLongPress()
    },
    [clear, onLongPress],
  )

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel: clear,
    onContextMenu,
  }
}
