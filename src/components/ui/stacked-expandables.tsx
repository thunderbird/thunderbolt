import { cn } from '@/lib/utils'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'

type StackedExpandablesProps = {
  children: React.ReactNode[]
  className?: string
}

/**
 * Container that manages multiple expandable components in a stack.
 * Shows the latest expandable on top and animates transitions.
 */
export const StackedExpandables = ({ children, className }: StackedExpandablesProps) => {
  const [activeIndex, setActiveIndex] = useState(children.length - 1)

  useEffect(() => {
    setActiveIndex(children.length - 1)
  }, [children.length])

  return (
    <div className={cn('relative', className)}>
      <AnimatePresence mode="wait">
        {children.map((child, index) => {
          const isActive = index === activeIndex
          const isBelow = index < activeIndex

          return (
            <motion.div
              key={index}
              initial={{ y: 20, opacity: 0 }}
              animate={{
                y: isActive ? 0 : isBelow ? -10 : 20,
                opacity: isActive ? 1 : 0,
                scale: isActive ? 1 : 0.98,
                zIndex: isActive ? 10 : isBelow ? index : 0,
              }}
              exit={{ y: -20, opacity: 0 }}
              transition={{
                duration: 0.3,
                ease: [0.4, 0, 0.2, 1], // Custom easing function
              }}
              className={cn('w-full', !isActive && 'pointer-events-none absolute inset-0')}
            >
              {child}
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
