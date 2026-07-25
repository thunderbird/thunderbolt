/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHaptics } from '@/hooks/use-haptics'
import { edgeSpacing, getMobileSidebarWidth, mobileSidebarWidthCss } from '@/lib/constants'
import { isMobile as isPlatformMobile } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer'
import { animate, m, useDragControls, useMotionValue, useReducedMotion, type PanInfo } from 'framer-motion'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import { MobileForegroundPortalProvider } from './mobile-foreground-portal'

type MobileSidebarProps = {
  enabled?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fires once the foreground has fully covered the sidebar. */
  onCloseComplete?: () => void
  /** Fires when reopening cancels an in-flight close. */
  onCloseCancel?: () => void
  sidebar: ReactNode
  children: ReactNode
}

// Keep in sync with the .mobile-sidebar-popup opacity transition in
// index.css — the foreground slide and the popup fade are one animation.
const drawerTransition = { duration: 0.3, ease: [0.22, 1, 0.36, 1] } as const
const instantTransition = { duration: 0 } as const
/** Foreground travel in px before a touch drag counts as opening the sidebar. */
const swipeActivationDistance = 8
/** Release speed in px/s that decides the resting side regardless of position. */
const swipeVelocityThreshold = 500
// Interactive elements keep their own tap behavior instead of starting a drag.
const swipeIgnoredSelector = 'button,a,input,select,textarea,label,[role="button"]'

// The 300px fallback only applies off-DOM (useSyncExternalStore's server
// snapshot); it approximates 80vw of a small phone.
const readSidebarWidth = () => (typeof window !== 'undefined' ? getMobileSidebarWidth(window.innerWidth) : 300)

const subscribeToResize = (onResize: () => void) => {
  window.addEventListener('resize', onResize)
  return () => window.removeEventListener('resize', onResize)
}

/**
 * Chooses the resting state from the foreground position and release velocity.
 */
export const shouldOpenMobileSidebar = (currentX: number, sidebarWidth: number, velocityX: number): boolean => {
  if (velocityX <= -swipeVelocityThreshold) {
    return false
  }
  if (velocityX >= swipeVelocityThreshold) {
    return true
  }
  return currentX >= sidebarWidth / 2
}

/**
 * Detects nested horizontal scrollers that should retain their native swipe.
 */
export const hasHorizontalScrollAncestor = (element: Element | null, boundary: HTMLElement): boolean => {
  if (!element || element === boundary) {
    return false
  }
  if (element instanceof HTMLElement) {
    const overflowX = window.getComputedStyle(element).overflowX
    if (/(auto|scroll)/.test(overflowX) && element.scrollWidth > element.clientWidth) {
      return true
    }
  }
  return hasHorizontalScrollAncestor(element.parentElement, boundary)
}

/**
 * Keeps taps, form controls, links, and horizontal scrollers out of the
 * navigation gesture while allowing the dedicated close surface.
 */
export const canStartSidebarDrag = (target: EventTarget | null, boundary: HTMLElement): boolean => {
  if (!(target instanceof Element)) {
    return false
  }
  if (target.closest('[data-sidebar-drag-surface]')) {
    return true
  }
  if (target.closest(swipeIgnoredSelector)) {
    return false
  }
  return !hasHorizontalScrollAncestor(target, boundary)
}

type UseMobileSidebarStateOptions = {
  enabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseComplete?: () => void
  onCloseCancel?: () => void
}

/**
 * Owns the open/close/drag lifecycle of the mobile sidebar: the foreground
 * motion value, the interruptible settle animation, mid-drag open-state
 * changes, and close-settlement notifications. The component consumes its
 * returned handlers and renders pure layout.
 */
const useMobileSidebarState = ({
  enabled,
  open,
  onOpenChange,
  onCloseComplete,
  onCloseCancel,
}: UseMobileSidebarStateOptions) => {
  const { triggerImpact } = useHaptics()
  const reducedMotion = useReducedMotion()
  const transition = reducedMotion ? instantTransition : drawerTransition
  const sidebarWidth = useSyncExternalStore(subscribeToResize, readSidebarWidth, readSidebarWidth)
  const effectiveOpen = enabled && open
  const x = useMotionValue(effectiveOpen ? sidebarWidth : 0)
  const dragControls = useDragControls()
  const [isPresented, setIsPresented] = useState(effectiveOpen)
  // Ref-mirrored so animation continuations always see the latest callbacks.
  // Not `useEffectEvent`: these fire from gesture handlers and animation
  // `finish` callbacks, which effect events are not allowed to serve.
  const onCloseCompleteRef = useRef(onCloseComplete)
  onCloseCompleteRef.current = onCloseComplete
  const onCloseCancelRef = useRef(onCloseCancel)
  onCloseCancelRef.current = onCloseCancel
  const targetOpenRef = useRef(effectiveOpen)
  targetOpenRef.current = effectiveOpen
  const previousOpenRef = useRef(effectiveOpen)
  // Bumped whenever an animation is superseded so a stale animation's finish
  // callback can recognize itself and bail.
  const animationTokenRef = useRef(0)
  const animationRef = useRef<ReturnType<typeof animate> | null>(null)
  const isClosePendingRef = useRef(false)
  const isDraggingRef = useRef(false)
  const dragStartedOpenRef = useRef(open)
  const didDragRef = useRef(false)

  /** Halts any in-flight animation and invalidates its finish callback. */
  const stopAnimation = useCallback(() => {
    animationTokenRef.current++
    animationRef.current?.stop()
    animationRef.current = null
  }, [])

  /** Resolves an awaited close request, if one is outstanding. */
  const flushPendingClose = useCallback(() => {
    if (isClosePendingRef.current) {
      isClosePendingRef.current = false
      onCloseCompleteRef.current?.()
    }
  }, [])

  const animateTo = useCallback(
    (nextOpen: boolean, notifyClose = false) => {
      stopAnimation()
      const token = animationTokenRef.current
      const target = nextOpen ? sidebarWidth : 0

      if (nextOpen) {
        setIsPresented(true)
        if (isClosePendingRef.current) {
          isClosePendingRef.current = false
          onCloseCancelRef.current?.()
        }
      } else if (notifyClose) {
        isClosePendingRef.current = true
      }

      const finish = () => {
        if (token !== animationTokenRef.current) {
          return
        }
        animationRef.current = null
        if (!nextOpen) {
          setIsPresented(false)
          flushPendingClose()
        }
      }

      if (x.get() === target) {
        finish()
        return
      }
      const animation = animate(x, target, transition)
      animationRef.current = animation
      void animation.then(finish)
    },
    [flushPendingClose, sidebarWidth, stopAnimation, transition, x],
  )

  // Settles the drawer after external `open`/`enabled` changes (and re-targets
  // the resting position when a resize changes the sidebar width). Gesture
  // handlers call `animateTo` directly for the transitions they own.
  useEffect(() => {
    const openChanged = previousOpenRef.current !== effectiveOpen
    previousOpenRef.current = effectiveOpen
    targetOpenRef.current = effectiveOpen
    if (isDraggingRef.current) {
      // Record an external close arriving mid-drag so handleDragEnd settles it
      // (complete or cancel) instead of stranding closeMobileSidebar() callers.
      if (openChanged && !effectiveOpen) {
        isClosePendingRef.current = true
      }
      return
    }
    if (!enabled) {
      stopAnimation()
      x.set(0)
      setIsPresented(false)
      flushPendingClose()
      return
    }
    animateTo(effectiveOpen, openChanged && !effectiveOpen)
  }, [animateTo, effectiveOpen, enabled, flushPendingClose, stopAnimation, x])

  useEffect(
    () => () => {
      stopAnimation()
      flushPendingClose()
    },
    [flushPendingClose, stopAnimation],
  )

  const handleOpenChange = (nextOpen: boolean) => {
    if (targetOpenRef.current === nextOpen) {
      return
    }
    triggerImpact('light')
    targetOpenRef.current = nextOpen
    onOpenChange(nextOpen)
    animateTo(nextOpen, !nextOpen)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.pointerType !== 'touch' || !canStartSidebarDrag(event.target, event.currentTarget)) {
      return
    }
    dragControls.start(event)
  }

  const handleDragStart = () => {
    stopAnimation()
    isDraggingRef.current = true
    didDragRef.current = true
    dragStartedOpenRef.current = targetOpenRef.current
  }

  const handleDrag = () => {
    if (targetOpenRef.current || x.get() < swipeActivationDistance) {
      return
    }
    targetOpenRef.current = true
    setIsPresented(true)
    onOpenChange(true)
  }

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    isDraggingRef.current = false
    const nextOpen = shouldOpenMobileSidebar(x.get(), sidebarWidth, info.velocity.x)
    const targetChanged = targetOpenRef.current !== nextOpen
    targetOpenRef.current = nextOpen

    if (targetChanged) {
      onOpenChange(nextOpen)
    }
    if (nextOpen !== dragStartedOpenRef.current) {
      triggerImpact('light')
    }

    animateTo(nextOpen, !nextOpen)
    // The browser synthesizes a click on the close surface right after the
    // drag's pointerup; keep the flag up for one frame so only that ghost
    // click is swallowed, never a deliberate later tap.
    requestAnimationFrame(() => {
      didDragRef.current = false
    })
  }

  const handleCloseSurfaceClick = () => {
    if (didDragRef.current) {
      return
    }
    handleOpenChange(false)
  }

  return {
    x,
    dragControls,
    sidebarWidth,
    drawerOpen: enabled && (open || isPresented),
    handleOpenChange,
    handlePointerDown,
    handleDragStart,
    handleDrag,
    handleDragEnd,
    handleCloseSurfaceClick,
  }
}

export const MobileSidebar = ({
  enabled = true,
  open,
  onOpenChange,
  onCloseComplete,
  onCloseCancel,
  sidebar,
  children,
}: MobileSidebarProps) => {
  const isNativeMobile = isPlatformMobile()
  const {
    x,
    dragControls,
    sidebarWidth,
    drawerOpen,
    handleOpenChange,
    handlePointerDown,
    handleDragStart,
    handleDrag,
    handleDragEnd,
    handleCloseSurfaceClick,
  } = useMobileSidebarState({ enabled, open, onOpenChange, onCloseComplete, onCloseCancel })

  const mobileSidebarCssVars = {
    '--mobile-sidebar-width': mobileSidebarWidthCss,
    // Native mobile pins the footer above the home indicator; web mobile
    // retains an extra 8px breathing room (same convention as the floating
    // controls in page-create-action.tsx).
    '--mobile-sidebar-footer-inset': isNativeMobile
      ? `max(var(--safe-area-bottom-padding), ${edgeSpacing.mobile}px)`
      : 'calc(var(--safe-area-bottom-padding, 0px) + 0.5rem)',
  } as CSSProperties

  // Stacking scheme while enabled (the wrapper isolates its own z context):
  // stationary menu viewport z-10 < foreground z-20 < close surface z-40
  // (above the foreground's own content, below the z-50 modal layer).
  return (
    <div
      data-slot="mobile-sidebar-layout"
      className={cn(
        'flex h-full w-full overflow-hidden',
        enabled ? 'pointer-events-none relative z-20 isolate' : 'flex-row',
      )}
    >
      {enabled ? (
        <DrawerPrimitive.Root
          key="mobile-sidebar"
          open={drawerOpen}
          onOpenChange={handleOpenChange}
          modal="trap-focus"
          disablePointerDismissal
          swipeDirection="left"
        >
          <DrawerPrimitive.Portal keepMounted>
            <DrawerPrimitive.Viewport className="pointer-events-auto fixed inset-0 z-10 select-none">
              <DrawerPrimitive.Popup
                data-base-ui-swipe-ignore
                data-sidebar="sidebar"
                data-slot="sidebar"
                data-mobile="true"
                className="mobile-sidebar-popup pointer-events-auto fixed inset-y-0 left-0 flex h-full w-[var(--mobile-sidebar-width)] flex-col bg-sidebar/80 text-sidebar-foreground outline-none backdrop-blur-lg motion-reduce:transition-none"
                style={mobileSidebarCssVars}
                onPointerDown={handlePointerDown}
              >
                <DrawerPrimitive.Title className="sr-only">Navigation</DrawerPrimitive.Title>
                <DrawerPrimitive.Content className="relative h-full select-text">
                  <div className="flex h-full w-full flex-col">{sidebar}</div>
                </DrawerPrimitive.Content>
              </DrawerPrimitive.Popup>
            </DrawerPrimitive.Viewport>
          </DrawerPrimitive.Portal>
        </DrawerPrimitive.Root>
      ) : (
        sidebar
      )}

      <m.div
        key="mobile-foreground"
        drag={enabled ? 'x' : false}
        dragControls={dragControls}
        dragConstraints={{ left: 0, right: sidebarWidth }}
        dragDirectionLock
        dragElastic={0.08}
        dragListener={false}
        dragMomentum={false}
        onPointerDown={handlePointerDown}
        onDragStart={handleDragStart}
        onDrag={handleDrag}
        onDragEnd={handleDragEnd}
        data-slot="sidebar-main"
        className={cn(
          'pointer-events-auto relative flex h-full min-w-0 flex-1 flex-col bg-background',
          enabled && 'mobile-sidebar-main-shadow z-20 will-change-transform',
        )}
        style={{ x: enabled ? x : 0, touchAction: enabled ? 'pan-y' : 'auto' }}
      >
        <div className="flex h-full min-w-0 flex-1 flex-col" inert={drawerOpen ? true : undefined}>
          <MobileForegroundPortalProvider>{children}</MobileForegroundPortalProvider>
        </div>
        {/* Doubles as the drag surface (see canStartSidebarDrag) and the
            tap-to-close surface while the drawer is open. tabIndex={-1}:
            keyboard users close via Escape and the drawer's focus trap; this
            surface exists for pointer taps and swipes on the exposed
            foreground edge. */}
        <m.button
          type="button"
          tabIndex={-1}
          aria-label="Close navigation"
          aria-hidden={!drawerOpen}
          data-sidebar-drag-surface
          className={cn(
            'absolute inset-0 z-40 cursor-default bg-transparent',
            drawerOpen ? 'pointer-events-auto' : 'pointer-events-none',
          )}
          onClick={handleCloseSurfaceClick}
        />
      </m.div>
    </div>
  )
}
