import { cn } from '@/lib/utils'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { animate, motion, useMotionValue, useTransform, type PanInfo } from 'framer-motion'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

interface MobileSidebarProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  side?: 'left' | 'right'
  className?: string
  style?: CSSProperties
}

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
  const sidebarWidth = typeof window !== 'undefined' ? window.innerWidth : 375

  // Transform x position to overlay opacity (fade out as sidebar moves away)
  const overlayOpacity = useTransform(
    x,
    side === 'left' ? [-sidebarWidth, 0] : [0, sidebarWidth],
    side === 'left' ? [0, 0.5] : [0.5, 0],
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
        await animate(x, 0, {
          type: 'spring',
          // Performance-optimized spring physics:
          // - Higher damping (35) = fewer oscillations, settles faster, less computation
          // - Higher stiffness (400) = snappier response, shorter animation duration
          // - Lower mass (0.8) = lighter feel, more responsive, better for mobile
          damping: 35,
          stiffness: 400,
          mass: 0.8,
        })
      }
      animateOpen()
    } else if (!open && internalOpen && !isAnimating) {
      // Closing: animate first, then close
      const animateClose = async () => {
        setIsAnimating(true)
        await animate(x, side === 'left' ? -sidebarWidth : sidebarWidth, {
          type: 'spring',
          // Same optimized spring physics for consistent feel across all animations
          damping: 35,
          stiffness: 400,
          mass: 0.8,
        })
        setIsAnimating(false)
        setInternalOpen(false)
      }
      animateClose()
    }
  }, [open, internalOpen, isAnimating, x, side, sidebarWidth])

  const handleClose = async () => {
    if (isAnimating) return

    setIsAnimating(true)
    await animate(x, side === 'left' ? -sidebarWidth : sidebarWidth, {
      type: 'spring',
      // Same optimized spring physics for consistent feel across all animations
      damping: 35,
      stiffness: 400,
      mass: 0.8,
    })
    setIsAnimating(false)
    setInternalOpen(false)
    onOpenChange(false)
  }

  const handleDragEnd = async (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const shouldClose =
      side === 'left' ? info.offset.x < -50 || info.velocity.x < -500 : info.offset.x > 50 || info.velocity.x > 500

    if (shouldClose) {
      await handleClose()
    } else {
      // Snap back to position with animation
      await animate(x, 0, {
        type: 'spring',
        // Same optimized spring physics for consistent feel across all animations
        damping: 35,
        stiffness: 400,
        mass: 0.8,
      })
    }
  }

  return (
    <DialogPrimitive.Root open={internalOpen}>
      <DialogPrimitive.Portal>
        {/* Animated overlay */}
        <motion.div
          className="fixed inset-0 z-50 bg-sidebar"
          style={{
            opacity: overlayOpacity,
            // willChange hints to browser this property will animate, enabling GPU acceleration
            willChange: 'opacity',
          }}
          onClick={handleClose}
        />

        {/* Animated sidebar content */}
        <motion.div
          drag="x"
          dragConstraints={{
            left: side === 'left' ? -sidebarWidth : 0,
            right: side === 'left' ? 0 : sidebarWidth,
          }}
          dragElastic={0.2}
          onDragEnd={handleDragEnd}
          style={{
            x,
            // willChange hints to browser this property will animate, enabling GPU acceleration
            // This promotes the element to its own compositing layer for smoother 60fps animations
            willChange: 'transform',
            ...style,
          }}
          className={cn(
            'bg-sidebar text-sidebar-foreground fixed inset-y-0 z-50 h-full w-full border-r shadow-lg flex flex-col',
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
              paddingBottom: 'env(safe-area-inset-bottom)',
              paddingTop: 'env(safe-area-inset-top)',
            }}
          >
            <div className="flex h-full w-full flex-col">{children}</div>
          </div>
        </motion.div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
