import { useState, useEffect, type ReactNode, type CSSProperties } from 'react'
import { motion, useMotionValue, useAnimation, type PanInfo } from 'framer-motion'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './sheet'
import { X } from 'lucide-react'
import { Button } from './button'
import { cn } from '@/lib/utils'

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
  const [isOpen, setIsOpen] = useState(open)
  const controls = useAnimation()
  const x = useMotionValue(0)
  const sidebarWidth = typeof window !== 'undefined' ? window.innerWidth : 375 // Full screen width

  useEffect(() => {
    setIsOpen(open)
    if (open) {
      controls.start({ x: 0 })
    }
  }, [open, controls])

  const handleDragEnd = async (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const shouldClose =
      side === 'left' ? info.offset.x < -50 || info.velocity.x < -500 : info.offset.x > 50 || info.velocity.x > 500

    if (shouldClose) {
      await controls.start({
        x: side === 'left' ? -sidebarWidth : sidebarWidth,
        transition: { type: 'spring', damping: 30, stiffness: 300 },
      })
      onOpenChange(false)
    } else {
      controls.start({
        x: 0,
        transition: { type: 'spring', damping: 30, stiffness: 300 },
      })
    }
  }

  return (
    <Sheet open={isOpen} onOpenChange={onOpenChange}>
      <SheetContent
        data-sidebar="sidebar"
        data-slot="sidebar"
        data-mobile="true"
        className={cn('bg-sidebar text-sidebar-foreground w-full p-0 [&>button]:hidden', className)}
        style={style}
        side={side}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Sidebar</SheetTitle>
          <SheetDescription>Displays the mobile sidebar.</SheetDescription>
        </SheetHeader>

        <motion.div
          drag="x"
          dragConstraints={{
            left: side === 'left' ? -sidebarWidth : 0,
            right: side === 'left' ? 0 : sidebarWidth,
          }}
          dragElastic={0.2}
          onDragEnd={handleDragEnd}
          animate={controls}
          style={{ x }}
          className="h-full w-full"
        >
          <div className="relative h-full">
            {/* Close button */}
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-4 h-8 w-8 rounded-full z-10"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close sidebar</span>
            </Button>

            <div className="flex h-full w-full flex-col">{children}</div>
          </div>
        </motion.div>
      </SheetContent>
    </Sheet>
  )
}
