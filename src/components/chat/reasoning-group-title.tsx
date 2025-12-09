import { formatDuration, splitPartType } from '@/lib/utils'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { type ToolUIPart } from 'ai'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'

type ReasoningGroupTitleProps = {
  totalDuration: number
  isGroupReasoning: boolean
  tools: ToolUIPart[]
}

export const ReasoningGroupTitle = ({ totalDuration, isGroupReasoning, tools }: ReasoningGroupTitleProps) => {
  const [activeIndex, setActiveIndex] = useState(tools.length - 1)

  useEffect(() => {
    setActiveIndex(tools.length - 1)
  }, [tools.length])

  const activeTool = tools[activeIndex]
  const activeToolMetadata = activeTool
    ? getToolMetadataSync(splitPartType(activeTool.type)[1], activeTool.input)
    : null

  return (
    <div className="relative">
      <AnimatePresence mode="wait">
        {isGroupReasoning ? (
          activeToolMetadata ? (
            <motion.div
              key={`tool-${activeIndex}`}
              // Skip entrance animation for tools already in progress (e.g., when switching back to a chat with active streaming)
              initial={activeTool?.state === 'input-streaming' ? { y: 20, opacity: 0 } : { y: 0, opacity: 1 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: -20, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
              className="w-full"
            >
              <span className="text-xs text-muted-foreground italic animate-pulse truncate min-w-0">
                {activeToolMetadata.loadingMessage}
              </span>
            </motion.div>
          ) : null
        ) : (
          <motion.div
            key="completed"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
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
