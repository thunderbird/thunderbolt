import { cn, formatDuration, splitPartType } from '@/lib/utils'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { type ToolUIPart } from 'ai'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'

type ReasoningGroupTitleProps = {
  totalDuration: number
  isThinking: boolean
  tools: ToolUIPart[]
}

export const ReasoningGroupTitle = ({ totalDuration, isThinking, tools }: ReasoningGroupTitleProps) => {
  const [activeIndex, setActiveIndex] = useState(tools.length - 1)

  useEffect(() => {
    setActiveIndex(tools.length - 1)
  }, [tools.length])

  return (
    <div className="relative">
      <AnimatePresence mode="wait">
        {isThinking ? (
          tools.map((tool, index) => {
            const isActive = index === activeIndex
            const isBelow = index < activeIndex

            const [, toolName] = splitPartType(tool.type)
            const metadata = getToolMetadataSync(toolName, tool.input)

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
                <span className="text-xs text-muted-foreground italic animate-pulse truncate min-w-0">
                  {metadata.loadingMessage}
                </span>
              </motion.div>
            )
          })
        ) : (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{
              y: 0,
              opacity: 1,
              scale: 1,
            }}
            transition={{
              duration: 0.3,
              ease: [0.4, 0, 0.2, 1], // Custom easing function
            }}
            className="w-full"
          >
            {tools.length > 0
              ? `Completed ${tools.length} steps in ${formatDuration(totalDuration)}`
              : `Thought for ${formatDuration(totalDuration)}`}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
