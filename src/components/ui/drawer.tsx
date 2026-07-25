/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer'
import type { ComponentProps } from 'react'

import { HapticMountBoundary } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'

/**
 * Gesture-driven sheet built on Base UI's Drawer (the maintained successor to
 * vaul, which this component previously wrapped). Only vertical sheets are
 * styled: `swipeDirection="down"` (default) is a bottom sheet, `"up"` a top
 * sheet. Unlike vaul, Base UI animates via CSS, so the open/close transitions
 * live in the classes below (`data-starting-style` / `data-ending-style`).
 */
const Drawer = (props: DrawerPrimitive.Root.Props) => <DrawerPrimitive.Root {...props} />

/** Re-exports Base UI's keyboard-inset provider, which publishes
 *  `--drawer-keyboard-inset` so sheets (e.g. `MobileActionSheet`) can ride
 *  above the software keyboard. */
const DrawerVirtualKeyboardProvider = (props: DrawerPrimitive.VirtualKeyboardProvider.Props) => (
  <DrawerPrimitive.VirtualKeyboardProvider {...props} />
)

/* Deliberately lighter than modalOverlayClass: a card drawer is a shallow,
 * swipe-away surface, so it dims and blurs less than a blocking modal, and
 * sits below the z-50 modal layer. Opacity tracks the swipe so the dimming
 * releases with the gesture. `absolute` under iOS Safari (paired with
 * `body { position: relative }` in index.css) keeps the backdrop covering the
 * viewport after the page has been scrolled. */
const backdropClass =
  'fixed inset-0 z-40 min-h-dvh bg-black/30 backdrop-blur-xs backdrop-saturate-75 select-none ' +
  'opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity duration-450 ease-[cubic-bezier(0.32,0.72,0,1)] ' +
  'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[ending-style]:pointer-events-none ' +
  'data-[ending-style]:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-[swiping]:duration-0 ' +
  'supports-[-webkit-touch-callout:none]:absolute'

const popupClass = cn(
  'group/drawer-content pointer-events-auto fixed z-50 flex h-auto max-h-[85dvh] w-full flex-col bg-popover/80 text-popover-foreground outline-none backdrop-blur-lg select-none',
  // Swipe follows the finger; open/close slide from/to the sheet's edge.
  'transform-[translate3d(0,var(--translate-y,0px),0)] transition-transform duration-450 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform',
  'data-[starting-style]:transform-[var(--closed-transform)] data-[ending-style]:transform-[var(--closed-transform)]',
  'data-[swiping]:duration-0 data-[ending-style]:duration-[calc(var(--drawer-swipe-strength)*400ms)]',
  // Directional shadows come from the --shadow-drawer-down/up tokens in
  // index.css :root — the single source they share with
  // .mobile-sidebar-main-shadow.
  // Bleed: fills the gap the sheet reveals at its own edge when a swipe
  // overshoots past the resting position. Sized generously (10rem) so even a
  // hard overshoot flick never exposes the sheet's outer edge.
  'after:pointer-events-none after:absolute after:inset-x-0 after:h-40 after:bg-popover/80 after:backdrop-blur-lg',
  'data-[swipe-direction=down]:inset-x-0 data-[swipe-direction=down]:bottom-0 data-[swipe-direction=down]:rounded-t-3xl data-[swipe-direction=down]:border-t data-[swipe-direction=down]:shadow-[var(--shadow-drawer-down)] data-[swipe-direction=down]:after:top-full data-[swipe-direction=down]:[--closed-transform:translate3d(0,calc(100%+2px),0)] data-[swipe-direction=down]:[--translate-y:var(--drawer-swipe-movement-y)]',
  'data-[swipe-direction=up]:inset-x-0 data-[swipe-direction=up]:top-0 data-[swipe-direction=up]:rounded-b-3xl data-[swipe-direction=up]:border-b data-[swipe-direction=up]:shadow-[var(--shadow-drawer-up)] data-[swipe-direction=up]:after:bottom-full data-[swipe-direction=up]:[--closed-transform:translate3d(0,calc(-100%-2px),0)] data-[swipe-direction=up]:[--translate-y:var(--drawer-swipe-movement-y)]',
)

type DrawerContentProps = DrawerPrimitive.Popup.Props & {
  /** Render the backdrop even when this drawer is nested in another drawer. */
  forceBackdrop?: boolean
}

const DrawerContent = ({ className, children, forceBackdrop = false, ...props }: DrawerContentProps) => {
  return (
    <DrawerPrimitive.Portal data-slot="drawer-portal">
      {/* Portal children mount when opening begins and unmount after the close
          transition. DrawerContent itself stays mounted while the drawer is
          closed, so the haptic must live inside the portal lifecycle. */}
      <HapticMountBoundary />
      <DrawerPrimitive.Backdrop data-slot="drawer-overlay" className={backdropClass} forceRender={forceBackdrop} />
      {/* Portaled events still bubble through the React tree, so this
          deliberately stops ALL parent pointerdown handling — not just the
          sidebar SwipeArea. The motivating case is an enclosing drawer's
          SwipeArea, which otherwise prevents desktop clicks while listening
          for swipe-open gestures, but any ancestor pointerdown handler is
          blocked while this drawer is open. */}
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        className="pointer-events-auto fixed inset-0 z-50 select-none"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <DrawerPrimitive.Popup data-slot="drawer-content" className={cn(popupClass, className)} {...props}>
          <DrawerPrimitive.Content className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit] select-text group-data-[swiping]/drawer-content:select-none">
            {children}
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  )
}

/* Base UI has no Handle part (vaul did) — the grab bar is decorative, so a
 * plain div is the intended replacement; the popup itself owns the gesture. */
const DrawerHandle = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    aria-hidden
    data-slot="drawer-handle"
    className={cn('mx-auto h-1 w-10 shrink-0 rounded-full bg-muted-foreground/10 dark:bg-white/5', className)}
    {...props}
  />
)

const DrawerTitle = ({ className, ...props }: DrawerPrimitive.Title.Props) => (
  <DrawerPrimitive.Title
    data-slot="drawer-title"
    className={cn('font-semibold text-foreground', className)}
    {...props}
  />
)

const DrawerDescription = ({ className, ...props }: DrawerPrimitive.Description.Props) => (
  <DrawerPrimitive.Description
    data-slot="drawer-description"
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
)

export { Drawer, DrawerContent, DrawerDescription, DrawerHandle, DrawerTitle, DrawerVirtualKeyboardProvider }
