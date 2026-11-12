/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type TransitionEvent } from 'react'

import { cn } from '@/lib/utils'

// Linear's spring curve — fast start, smooth tail, no overshoot.
const slideEasing = 'cubic-bezier(0.32, 0.72, 0, 1)'

/**
 * An inline right-side detail panel (no overlay, no portal). Rendered as a real
 * flex child so the sibling list to its left shrinks to make room instead of
 * being covered. Opening expands the outer width while the fixed-width content
 * is revealed from the right. Fills the height
 * of its flex row; the caller styles/scrolls the `children`.
 *
 * `width` must be viewport-relative or fixed (vw/px/clamp), not a percentage —
 * the inner content div reuses it as a stable width while the outer collapses
 * to 0, and a percentage would resolve against the collapsed parent.
 */
export const SlideInPanel = ({
  open,
  width,
  className,
  onCloseComplete,
  children,
}: {
  open: boolean
  width: string
  className?: string
  /** Fires after the closing width transition (or immediately for reduced motion). */
  onCloseComplete?: () => void
  children: ReactNode
}) => {
  const previousOpenRef = useRef(open)
  // Lazy panels can arrive after their parent's opening frames. CSS keyframes
  // give that first mount an entrance too, including on older WebKit versions.
  const [enteringOnMount, setEnteringOnMount] = useState(open)
  if (enteringOnMount && !open) {
    setEnteringOnMount(false)
  }

  useEffect(() => {
    const wasOpen = previousOpenRef.current
    previousOpenRef.current = open
    if (wasOpen && !open && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onCloseComplete?.()
    }
  }, [onCloseComplete, open])

  const handleTransitionEnd = (event: TransitionEvent<HTMLElement>) => {
    if (!open && event.target === event.currentTarget && event.propertyName === 'width') {
      onCloseComplete?.()
    }
  }

  return (
    <aside
      data-slot="slide-in-panel"
      // z-30 lifts the panel above the layout's top header scrim (z-20) so the
      // gradient fades out over the list only and never washes over the panel's
      // top edge. The panel starts below the header, so nothing else competes.
      className={cn(
        'relative z-30 h-full shrink-0 overflow-hidden transition-[width] duration-300 motion-reduce:transition-none motion-reduce:animate-none',
        enteringOnMount && 'animate-[slide-in-panel-open_300ms]',
        className,
      )}
      style={
        {
          '--slide-panel-width': width,
          width: open ? width : '0px',
          transitionTimingFunction: slideEasing,
          animationTimingFunction: slideEasing,
        } as CSSProperties
      }
      aria-hidden={!open}
      inert={!open}
      onTransitionEnd={handleTransitionEnd}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) {
          setEnteringOnMount(false)
        }
      }}
    >
      <div className="h-full" style={{ width }}>
        {children}
      </div>
    </aside>
  )
}
