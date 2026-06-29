/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHaptics } from '@/hooks/use-haptics'
import { mobileSidebarWidthRatio } from '@/lib/constants'
import { cn } from '@/lib/utils'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { animate, m, useMotionValue, useReducedMotion, useTransform, type PanInfo } from 'framer-motion'
import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'

type MobileSidebarProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
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
  children,
  side = 'left',
  className,
  style,
}: MobileSidebarProps) => {
  const [isAnimating, setIsAnimating] = useState(false)
  const [internalOpen, setInternalOpen] = useState(open)
  const x = useMotionValue(0)
  const { triggerImpact } = useHaptics()

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

  // Handle external open/close requests
  useEffect(() => {
    if (open && !internalOpen) {
      // Opening: set position first, then animate in
      // Set position synchronously before rendering to avoid flicker
      x.set(side === 'left' ? -sidebarWidth : sidebarWidth)
      setInternalOpen(true)

      // Animate to position after render
      const animateOpen = async () => {
        await animate(x, 0, transition)
      }
      animateOpen()
    } else if (!open && internalOpen && !isAnimating) {
      // Closing: animate first, then close
      const animateClose = async () => {
        setIsAnimating(true)
        await animate(x, side === 'left' ? -sidebarWidth : sidebarWidth, transition)
        setIsAnimating(false)
        setInternalOpen(false)
      }
      animateClose()
    }
  }, [open, internalOpen, isAnimating, x, side, sidebarWidth, transition])

  const handleClose = async () => {
    if (isAnimating) {
      return
    }

    triggerImpact('light')
    setIsAnimating(true)
    await animate(x, side === 'left' ? -sidebarWidth : sidebarWidth, transition)
    setIsAnimating(false)
    setInternalOpen(false)
    onOpenChange(false)
  }

  const handleDragEnd = async (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (shouldCloseOnDragEnd(side, info)) {
      await handleClose()
    } else {
      // Snap back to the open position
      await animate(x, 0, transition)
    }
  }

  return (
    <DialogPrimitive.Root open={internalOpen}>
      <DialogPrimitive.Portal>
        {/* Dim overlay — plain opacity fade (compositor-only). Intentionally NOT blurred:
            unlike the app's Radix sheet/dialog overlays (bg-black/50 backdrop-blur-md), this
            skips backdrop-filter because animating opacity on a blur layer forces a per-frame
            re-blur of the scene behind it — the main source of close-animation jank on mobile. */}
        <m.div
          data-slot="sidebar-overlay"
          className="fixed inset-0 z-50 bg-black/40"
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
          onDragEnd={handleDragEnd}
          style={{ x, ...style }}
          className={cn(
            'bg-sidebar text-sidebar-foreground fixed inset-y-0 z-50 h-full w-[80vw] border-r shadow-lg flex flex-col',
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
              paddingBottom: 'var(--safe-area-bottom-padding)',
              paddingTop: 'var(--safe-area-top-padding)',
            }}
          >
            <div className="flex h-full w-full flex-col">{children}</div>
          </div>
        </m.div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
