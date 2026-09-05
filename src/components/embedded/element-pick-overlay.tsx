/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

import type { SurfaceHighlightedElement } from './types'

/**
 * How often the pointer position is sent to the guest, in milliseconds.
 *
 * Every move is a `postMessage` round trip into the frame, so this is a real
 * budget rather than a nicety. ~60ms keeps the outline feeling attached to the
 * cursor while leaving the guest's main thread alone — the frame shares it with
 * everything else the app is doing.
 */
const pointerThrottleMs = 60

/**
 * How close to the top of the surface the outline has to be before the label
 * moves below it, in px.
 *
 * Roughly the label's own height: any less and it would be clipped by the
 * surface edge rather than sitting above the outline. Named because the
 * comparison reads as arbitrary otherwise — `selection-popover.tsx` does the
 * same thing with its own threshold.
 */
const labelFlipThreshold = 28

/** Space between the label and the outline it names, in px. */
const labelGap = 4

type ElementPickOverlayProps = {
  /** The element the guest last reported under the pointer, if any. */
  element: SurfaceHighlightedElement | null
  /** Ask what sits at a point, in overlay-local (== guest viewport) coordinates. */
  onPoint: (point: { x: number; y: number }) => void
  /**
   * The user committed, at this point. The point rather than the outlined
   * element because the outline can be one answer behind the pointer — see
   * `pickAt`, which decides which of the two the click meant.
   */
  onPick: (point: { x: number; y: number }) => void
  onCancel: () => void
}

/**
 * Full-bleed capture layer for element picking.
 *
 * Sits above the iframe and takes the pointer, so the embedded app receives no
 * events while picking — which is what lets the *host* own this interaction
 * entirely. The app is never asked to track the pointer or draw anything; it
 * only answers `ui/element-at` with what sits at a coordinate.
 *
 * That division is why this replaced the marquee rather than being added beside
 * it. Both gestures ask the guest one question; pointing asks a question with
 * one right answer, where a rectangle asks the guest to guess which of several
 * overlapping things the user meant.
 *
 * The dim is drawn as a huge spread `box-shadow` on the outline element rather
 * than four surrounding divs: one element, no seams between panels, and the
 * "hole" tracks the highlighted element for free.
 */
export const ElementPickOverlay = ({ element, onPoint, onPick, onCancel }: ElementPickOverlayProps) => {
  const layerRef = useRef<HTMLDivElement>(null)
  const lastSentAt = useRef(0)
  /** The most recent position the throttle suppressed, waiting on the flush. */
  const pendingPoint = useRef<{ x: number; y: number } | null>(null)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Pointer position relative to the overlay, which is flush with the iframe. */
  const toLocal = useCallback((event: { clientX: number; clientY: number }) => {
    const bounds = layerRef.current?.getBoundingClientRect()
    return { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) }
  }, [])

  /** Escape leaves pick mode — the expected way out of a modal tool. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  // A pending flush outlives the gesture otherwise, asking the guest about a
  // position on a surface the user has already left.
  useEffect(
    () => () => {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current)
      }
    },
    [],
  )

  const send = useCallback(
    (point: { x: number; y: number }) => {
      lastSentAt.current = performance.now()
      pendingPoint.current = null
      onPoint(point)
    },
    [onPoint],
  )

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    /*
     * Throttled rather than debounced: a debounce would only ask once the
     * pointer stopped, so the outline would lag behind a moving cursor and then
     * snap — the opposite of the feel this gesture needs.
     *
     * But leading edge alone dropped the *last* move of a gesture. Suppress a
     * position because it arrived 20ms after the previous one, and if the
     * pointer then stops — which is exactly what it does before a click — no
     * further event ever comes to replace it, so the outline stays on an
     * element the pointer has left, permanently. The trailing flush below is
     * what makes the final position always arrive.
     */
    const point = toLocal(event)
    const wait = pointerThrottleMs - (performance.now() - lastSentAt.current)
    if (wait <= 0) {
      send(point)
      return
    }
    pendingPoint.current = point
    flushTimer.current ??= setTimeout(() => {
      flushTimer.current = null
      if (pendingPoint.current) {
        send(pendingPoint.current)
      }
    }, wait)
  }

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 z-30 cursor-crosshair"
      onPointerMove={handlePointerMove}
      // `onClick` rather than pointerdown: a click is the commit, and committing
      // on press would fire before the guest had answered for that position.
      onClick={(event) => onPick(toLocal(event))}
    >
      {element && (
        <div
          className="pointer-events-none absolute rounded-md ring-2 ring-primary transition-[top,left,width,height] duration-75"
          style={{
            top: element.rect.y,
            left: element.rect.x,
            width: element.rect.width,
            height: element.rect.height,
            // The dim lives on the outline so the hole follows it for free.
            boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.35)',
          }}
        >
          {/*
            Anchored below the outline, and above it when there isn't room — the
            label must never cover the thing it names.
          */}
          <span
            className="absolute left-0 max-w-full truncate rounded-md bg-primary px-1.5 py-0.5 text-[length:var(--font-size-xs)] text-primary-foreground"
            style={
              element.rect.y < labelFlipThreshold
                ? { top: '100%', marginTop: labelGap }
                : { bottom: '100%', marginBottom: labelGap }
            }
          >
            {element.label}
          </span>
        </div>
      )}
    </div>
  )
}
