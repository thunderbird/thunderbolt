/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHaptics } from '@/hooks/use-haptics'
import { edgeSpacing, mobileSidebarWidthRatio } from '@/lib/constants'
import { isMobile as isPlatformMobile } from '@/lib/platform'
import { cn } from '@/lib/utils'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { animate, m, useMotionValue, useReducedMotion, useTransform, type PanInfo } from 'framer-motion'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'

type MobileSidebarProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fires once the close animation has fully settled (both the external
   *  `open=false` path and user-initiated dismissals). Lets callers defer
   *  heavy work — e.g. navigation — until the spring is done. */
  onCloseComplete?: () => void
  children: ReactNode
  side?: 'left' | 'right'
  className?: string
  style?: CSSProperties
}

/**
 * Spring shared by every drawer transition (open, close, drag snap-back). High damping and
 * stiffness with low mass keep it near-critically-damped: it settles quickly without
 * overshoot and stays interruptible for the drag-to-close gesture.
 */
const drawerSpring = { type: 'spring', damping: 35, stiffness: 400, mass: 0.8 } as const

/** Instant transition used under `prefers-reduced-motion`: jumps to the target with no spring travel. */
const instantTransition = { duration: 0 } as const

/** Slide distance for the drawer (its rendered width, 80vw), or a sane fallback off-DOM. */
const readSidebarWidth = () => (typeof window !== 'undefined' ? window.innerWidth * mobileSidebarWidthRatio : 300)

const subscribeToResize = (onResize: () => void) => {
  window.addEventListener('resize', onResize)
  return () => window.removeEventListener('resize', onResize)
}

/**
 * Decides whether a drag-end gesture should dismiss the drawer: closes when it has been
 * dragged past the 50px threshold toward its edge, or flicked there fast enough (velocity
 * beyond 500px/s) in the closing direction.
 */
export const shouldCloseOnDragEnd = (side: 'left' | 'right', info: PanInfo): boolean =>
  side === 'left' ? info.offset.x < -50 || info.velocity.x < -500 : info.offset.x > 50 || info.velocity.x > 500

export const MobileSidebar = ({
  open,
  onOpenChange,
  onCloseComplete,
  children,
  side = 'left',
  className,
  style,
}: MobileSidebarProps) => {
  const [internalOpen, setInternalOpen] = useState(open)
  const x = useMotionValue(0)
  const { triggerImpact } = useHaptics()
  // Native mobile gets the blur backdrop and the safe-area-aware bottom padding.
  const isNativeMobile = isPlatformMobile()

  // Honor prefers-reduced-motion: drive every open/close/snap-back with an instant transition
  // (no spring travel) while keeping drag-to-dismiss and the overlay dim intact. Derived during
  // render — both branches are stable module constants, so this stays referentially safe in deps.
  const reducedMotion = useReducedMotion()
  const transition = reducedMotion ? instantTransition : drawerSpring

  // The drawer renders at w-[80vw]; track that slide distance live so the off-screen
  // animation target and drag constraints stay correct across viewport resizes/rotations.
  // useSyncExternalStore reads window.innerWidth once per render (vs the old 3x) plus on
  // resize — the house pattern (see use-mobile.ts), no extra effect.
  const sidebarWidth = useSyncExternalStore(subscribeToResize, readSidebarWidth, readSidebarWidth)

  // Fade the dim overlay as the sidebar slides: full opacity when open, transparent when off-screen.
  const overlayOpacity = useTransform(
    x,
    side === 'left' ? [-sidebarWidth, 0] : [0, sidebarWidth],
    side === 'left' ? [0, 1] : [1, 0],
  )

  // Latest callback props, readable from animation continuations (which
  // outlive the render that started them) without re-binding — the callbacks
  // may be unstable inline functions. Event handlers don't need this: they
  // are re-created each render, so they already see the current props.
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const onCloseCompleteRef = useRef(onCloseComplete)
  onCloseCompleteRef.current = onCloseComplete

  // If the drawer unmounts mid-close (e.g. the viewport crosses to desktop
  // while the spring is running), the animation never settles and the pending
  // notification would be dropped — callers awaiting `closeMobileSidebar()`
  // would hang forever. Flush on unmount; the provider's resolver queue
  // no-ops when nothing is pending.
  useEffect(() => () => onCloseCompleteRef.current?.(), [])

  const closedX = side === 'left' ? -sidebarWidth : sidebarWidth

  // Monotonic token that identifies the latest close request. Grabbing the
  // drawer mid-close bumps it, so a superseded close animation can never
  // commit a stale "closed" state. This exists because an `animate()` promise
  // interrupted by a drag gesture is not guaranteed to resolve — awaiting it
  // unguarded can strand the drawer half-open with the (invisible) overlay
  // still mounted, blocking the whole app until restart.
  const closeTokenRef = useRef(0)

  const startClose = useCallback(() => {
    const token = ++closeTokenRef.current
    void animate(x, closedX, transition).then(() => {
      if (token !== closeTokenRef.current) {
        return
      }
      setInternalOpen(false)
      onOpenChangeRef.current(false)
      onCloseCompleteRef.current?.()
    })
  }, [x, closedX, transition])

  // Handle external open/close requests
  useEffect(() => {
    if (open && !internalOpen) {
      // Opening: set the off-screen position synchronously before rendering to
      // avoid flicker, then animate in. Also invalidates any in-flight close.
      closeTokenRef.current++
      x.set(closedX)
      setInternalOpen(true)
      void animate(x, 0, transition)
    } else if (!open && internalOpen) {
      startClose()
    }
  }, [open, internalOpen, x, closedX, transition, startClose])

  const handleClose = () => {
    triggerImpact('light')
    startClose()
  }

  const handleDragStart = () => {
    // The user grabbed the drawer: any pending close no longer owns the
    // outcome — the next drag end decides it.
    closeTokenRef.current++
  }

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (shouldCloseOnDragEnd(side, info)) {
      triggerImpact('light')
      startClose()
      return
    }
    // Snap back to the open position. If the parent already considers the
    // drawer closed (the user caught it mid-close and kept it open), re-sync
    // it and flush any callers awaiting the close so they aren't stranded.
    void animate(x, 0, transition)
    if (!open) {
      onOpenChange(true)
      onCloseComplete?.()
    }
  }

  return (
    <DialogPrimitive.Root open={internalOpen}>
      <DialogPrimitive.Portal>
        {/* Keep the filter constant on its own compositing layer. Its opacity
            follows the drawer so blur and tint fade together without animating
            the blur radius itself. */}
        {isNativeMobile && (
          <m.div
            data-slot="sidebar-blur"
            className="pointer-events-none fixed inset-0 z-50 backdrop-blur-sm backdrop-saturate-[.25] will-change-[opacity]"
            style={{ opacity: overlayOpacity }}
          />
        )}

        {/* The interactive tint remains paint-only and shares the same fade. */}
        <m.div
          data-slot="sidebar-overlay"
          className="fixed inset-0 z-50 bg-black/40 will-change-[opacity]"
          style={{ opacity: overlayOpacity }}
          onClick={handleClose}
        />

        {/* Animated sidebar content */}
        <m.div
          drag="x"
          dragConstraints={{
            left: side === 'left' ? -sidebarWidth : 0,
            right: side === 'left' ? 0 : sidebarWidth,
          }}
          dragElastic={0.2}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          style={{ x, ...style }}
          className={cn(
            'bg-sidebar/80 text-sidebar-foreground fixed inset-y-0 z-50 h-full w-[80vw] shadow-lg flex flex-col backdrop-blur-lg will-change-transform',
            side === 'left' ? 'left-0' : 'right-0',
            className,
          )}
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
        >
          <div
            className="relative h-full"
            style={{
              paddingBottom: isNativeMobile
                ? `max(var(--safe-area-bottom-padding), ${edgeSpacing.mobile}px)`
                : 'var(--safe-area-bottom-padding)',
              paddingTop: 'var(--header-safe-area-top)',
            }}
          >
            <div className="flex h-full w-full flex-col">{children}</div>
          </div>
        </m.div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
