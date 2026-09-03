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

type ElementPickOverlayProps = {
  /** The element the guest last reported under the pointer, if any. */
  element: SurfaceHighlightedElement | null
  /** Ask what sits at a point, in overlay-local (== guest viewport) coordinates. */
  onPoint: (point: { x: number; y: number }) => void
  /** The user clicked while an element was outlined. */
  onPick: (element: SurfaceHighlightedElement) => void
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

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    /*
     * Throttled on a timestamp rather than debounced. A debounce would only ask
     * once the pointer stopped, so the outline would lag behind a moving cursor
     * and then snap — the opposite of the feel this gesture needs.
     */
    const now = event.timeStamp
    if (now - lastSentAt.current < pointerThrottleMs) {
      return
    }
    lastSentAt.current = now
    onPoint(toLocal(event))
  }

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 z-30 cursor-crosshair"
      onPointerMove={handlePointerMove}
      // `onClick` rather than pointerdown: a click is the commit, and committing
      // on press would fire before the guest had answered for that position.
      onClick={() => element && onPick(element)}
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
            style={element.rect.y < 28 ? { top: '100%', marginTop: 4 } : { bottom: '100%', marginBottom: 4 }}
          >
            {element.label}
          </span>
        </div>
      )}
    </div>
  )
}
