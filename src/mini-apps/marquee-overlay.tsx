/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MiniAppRect } from '@shared/mini-app-protocol'
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/** A drag smaller than this in either axis is treated as a click, not a marquee. */
const minimumDragPx = 8

type Point = { x: number; y: number }

/** Normalize a drag into a positive-area rect, whichever way it was dragged. */
export const rectFromDrag = (start: Point, end: Point): MiniAppRect => ({
  x: Math.min(start.x, end.x),
  y: Math.min(start.y, end.y),
  width: Math.abs(end.x - start.x),
  height: Math.abs(end.y - start.y),
})

/** Whether a drag is deliberate enough to query, rather than a stray click. */
export const isMeaningfulDrag = (rect: MiniAppRect): boolean =>
  rect.width >= minimumDragPx && rect.height >= minimumDragPx

type MarqueeOverlayProps = {
  /** Called with the drawn rect, in overlay-local (== guest viewport) coordinates. */
  onSelect: (rect: MiniAppRect) => void
  onCancel: () => void
}

/**
 * Full-bleed capture layer for marquee selection.
 *
 * Sits above the iframe and takes the pointer, so the embedded app receives no
 * events while selecting — which is what lets the *host* own this interaction
 * entirely. The app is never asked to track a drag; it only answers
 * `selection/query` once, at the end.
 *
 * The dim is drawn as a huge spread `box-shadow` on the marquee element rather
 * than four surrounding divs: one element, no seams between panels, and the
 * "hole" tracks the box for free.
 */
export const MarqueeOverlay = ({ onSelect, onCancel }: MarqueeOverlayProps) => {
  const layerRef = useRef<HTMLDivElement>(null)
  const startRef = useRef<Point | null>(null)
  const [rect, setRect] = useState<MiniAppRect | null>(null)

  /** Pointer position relative to the overlay, which is flush with the iframe. */
  const toLocal = useCallback((event: { clientX: number; clientY: number }): Point => {
    const bounds = layerRef.current?.getBoundingClientRect()
    return { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) }
  }, [])

  /** Escape leaves select mode — the expected way out of a modal tool. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Capture so the drag survives the pointer leaving the overlay — releasing
    // outside the panel should still complete the selection, not strand it.
    event.currentTarget.setPointerCapture(event.pointerId)
    startRef.current = toLocal(event)
    setRect({ ...startRef.current, width: 0, height: 0 })
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!startRef.current) {
      return
    }
    setRect(rectFromDrag(startRef.current, toLocal(event)))
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current
    startRef.current = null
    if (!start) {
      return
    }
    const drawn = rectFromDrag(start, toLocal(event))
    setRect(null)
    if (!isMeaningfulDrag(drawn)) {
      onCancel()
      return
    }
    onSelect(drawn)
  }

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 z-30 cursor-crosshair"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      role="presentation"
    >
      {/* Uniform dim until a drag starts, so the mode is obvious before the first move. */}
      {!rect && <div className="absolute inset-0 bg-black/45" />}
      {rect && (
        <div
          className="absolute border-2 border-primary rounded-md"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
          }}
        />
      )}
    </div>
  )
}
