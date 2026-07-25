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

const drawerTransition = { duration: 0.3, ease: [0.22, 1, 0.36, 1] } as const
const instantTransition = { duration: 0 } as const
const swipeActivationDistance = 8
const swipeVelocityThreshold = 500
const swipeIgnoredSelector = 'button,a,input,select,textarea,label,[role="button"],[data-sidebar-swipe-ignore]'

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
const hasHorizontalScrollAncestor = (element: Element | null, boundary: HTMLElement): boolean => {
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
const canStartSidebarDrag = (target: EventTarget | null, boundary: HTMLElement): boolean => {
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

export const MobileSidebar = ({
  enabled = true,
  open,
  onOpenChange,
  onCloseComplete,
  onCloseCancel,
  sidebar,
  children,
}: MobileSidebarProps) => {
  const { triggerImpact } = useHaptics()
  const isNativeMobile = isPlatformMobile()
  const reducedMotion = useReducedMotion()
  const transition = reducedMotion ? instantTransition : drawerTransition
  const sidebarWidth = useSyncExternalStore(subscribeToResize, readSidebarWidth, readSidebarWidth)
  const effectiveOpen = enabled && open
  const x = useMotionValue(effectiveOpen ? sidebarWidth : 0)
  const dragControls = useDragControls()
  const [presented, setPresented] = useState(effectiveOpen)
  const [settleVersion, setSettleVersion] = useState(0)
  const onCloseCompleteRef = useRef(onCloseComplete)
  onCloseCompleteRef.current = onCloseComplete
  const onCloseCancelRef = useRef(onCloseCancel)
  onCloseCancelRef.current = onCloseCancel
  const targetOpenRef = useRef(effectiveOpen)
  targetOpenRef.current = effectiveOpen
  const previousOpenRef = useRef(effectiveOpen)
  const closeTokenRef = useRef(0)
  const animationRef = useRef<ReturnType<typeof animate> | null>(null)
  const pendingCloseRef = useRef(false)
  const draggingRef = useRef(false)
  const dragStartedOpenRef = useRef(open)
  const didDragRef = useRef(false)

  const animateTo = useCallback(
    (nextOpen: boolean, notifyClose = false) => {
      const token = ++closeTokenRef.current
      const target = nextOpen ? sidebarWidth : 0
      animationRef.current?.stop()
      animationRef.current = null

      if (nextOpen) {
        setPresented(true)
        if (pendingCloseRef.current) {
          pendingCloseRef.current = false
          onCloseCancelRef.current?.()
        }
      } else if (notifyClose) {
        pendingCloseRef.current = true
      }

      const finish = () => {
        if (token !== closeTokenRef.current) {
          return
        }
        animationRef.current = null
        if (!nextOpen) {
          setPresented(false)
          if (pendingCloseRef.current) {
            pendingCloseRef.current = false
            onCloseCompleteRef.current?.()
          }
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
    [sidebarWidth, transition, x],
  )

  useEffect(() => {
    const openChanged = previousOpenRef.current !== effectiveOpen
    previousOpenRef.current = effectiveOpen
    targetOpenRef.current = effectiveOpen
    if (draggingRef.current) {
      return
    }
    if (!enabled) {
      closeTokenRef.current++
      animationRef.current?.stop()
      animationRef.current = null
      x.set(0)
      setPresented(false)
      if (pendingCloseRef.current) {
        pendingCloseRef.current = false
        onCloseCompleteRef.current?.()
      }
      return
    }
    animateTo(effectiveOpen, openChanged && !effectiveOpen)
  }, [animateTo, effectiveOpen, enabled, settleVersion, x])

  useEffect(
    () => () => {
      closeTokenRef.current++
      animationRef.current?.stop()
      animationRef.current = null
      if (pendingCloseRef.current) {
        pendingCloseRef.current = false
        onCloseCompleteRef.current?.()
      }
    },
    [],
  )

  const handleOpenChange = (nextOpen: boolean) => {
    if (targetOpenRef.current === nextOpen) {
      return
    }
    triggerImpact('light')
    targetOpenRef.current = nextOpen
    onOpenChange(nextOpen)
    setSettleVersion((version) => version + 1)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.pointerType !== 'touch' || !canStartSidebarDrag(event.target, event.currentTarget)) {
      return
    }
    dragControls.start(event)
  }

  const handleDragStart = () => {
    closeTokenRef.current++
    animationRef.current?.stop()
    animationRef.current = null
    draggingRef.current = true
    didDragRef.current = true
    dragStartedOpenRef.current = targetOpenRef.current
  }

  const handleDrag = () => {
    if (targetOpenRef.current || x.get() < swipeActivationDistance) {
      return
    }
    targetOpenRef.current = true
    setPresented(true)
    onOpenChange(true)
  }

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    draggingRef.current = false
    const nextOpen = shouldOpenMobileSidebar(x.get(), sidebarWidth, info.velocity.x)
    const targetChanged = targetOpenRef.current !== nextOpen
    targetOpenRef.current = nextOpen

    if (targetChanged) {
      onOpenChange(nextOpen)
    }
    if (nextOpen !== dragStartedOpenRef.current) {
      triggerImpact('light')
    }

    setSettleVersion((version) => version + 1)
    requestAnimationFrame(() => {
      didDragRef.current = false
    })
  }

  const handleBackdropClick = () => {
    if (didDragRef.current) {
      return
    }
    handleOpenChange(false)
  }

  const sidebarWidthStyle = {
    '--mobile-sidebar-width': mobileSidebarWidthCss,
    '--mobile-sidebar-footer-inset': isNativeMobile
      ? `max(var(--safe-area-bottom-padding), ${edgeSpacing.mobile}px)`
      : 'calc(var(--safe-area-bottom-padding, 0px) + 0.5rem)',
  } as CSSProperties
  const drawerOpen = enabled && (open || presented)

  return (
    <div
      data-slot="mobile-sidebar-layout"
      className={cn(
        'flex h-full w-full overflow-hidden',
        enabled ? 'pointer-events-none relative z-20 isolate' : 'flex-row',
      )}
      style={sidebarWidthStyle}
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
                style={sidebarWidthStyle}
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
          'mobile-sidebar-main pointer-events-auto relative flex h-full min-w-0 flex-1 flex-col bg-background',
          enabled && 'mobile-sidebar-main-shadow z-20 will-change-transform',
        )}
        style={{ x: enabled ? x : 0, touchAction: enabled ? 'pan-y' : 'auto' }}
      >
        <div className="flex h-full min-w-0 flex-1 flex-col" inert={drawerOpen ? true : undefined}>
          <MobileForegroundPortalProvider>{children}</MobileForegroundPortalProvider>
        </div>
        <m.button
          type="button"
          tabIndex={-1}
          aria-label="Close navigation"
          aria-hidden={!drawerOpen}
          data-sidebar-drag-surface
          className={`absolute inset-0 z-40 cursor-default bg-transparent ${
            drawerOpen ? 'pointer-events-auto' : 'pointer-events-none'
          }`}
          onClick={handleBackdropClick}
        />
      </m.div>
    </div>
  )
}
