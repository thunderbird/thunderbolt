/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'
import { canLinuxEdgeResize, edgeCursorAt, isInteractiveTarget, startLinuxEdgeResize } from '@/lib/edge-resize'

/**
 * Restores edge/corner resize for the frameless window on Linux, where an
 * undecorated window currently has no native resize band at all
 * (tauri-apps/tauri#16266). Listens once on the document (capture), forwards edge
 * presses to the native resize path, and shows the matching cursor so the edges are
 * discoverable. No-op on every other platform; remove once the upstream fix lands.
 */
export const useLinuxEdgeResize = (): void => {
  useEffect(() => {
    if (!canLinuxEdgeResize()) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => startLinuxEdgeResize(event)

    // Show the resize cursor over the band. Set on the root element rather than the
    // element under the pointer: we must not mutate the app's own styles, and the
    // root is the one node guaranteed to exist. An element that declares its own
    // cursor still wins there — acceptable, since interactive controls are skipped
    // anyway and the band is otherwise window chrome.
    const root = document.documentElement
    let applied = ''
    const setCursor = (value: string): void => {
      if (value === applied) {
        return
      }
      applied = value
      root.style.cursor = value
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (event.buttons !== 0) {
        return // a drag is in progress; leave the cursor to whoever owns it
      }
      const cursor = isInteractiveTarget(event.target)
        ? null
        : edgeCursorAt(event.clientX, event.clientY, window.innerWidth, window.innerHeight)
      setCursor(cursor ?? '')
    }
    const onPointerLeave = (): void => setCursor('')

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
    document.addEventListener('pointerleave', onPointerLeave, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerleave', onPointerLeave, true)
      setCursor('')
    }
  }, [])
}
