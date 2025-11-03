import type { ReasoningUIPart, ToolUIPart } from 'ai'
import { AnimatePresence, motion } from 'framer-motion'
import { useObjectView } from './object-view-provider'
import { ToolItem } from './tool-item'
import { type ReasoningGroupItem } from '@/lib/assistant-message'
import { useMemo } from 'react'
import { ReasoningItem } from './reasoning-item'
import { useAutoScroll } from '@/hooks/use-auto-scroll'

type UseReasoningGroupStateParams = {
  parts: ReasoningGroupItem[]
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextInMessage: boolean
}

/**
 * Computes the display state for a tool group, including completion status
 * and whether to show a loading indicator for the next action.
 * @internal - Exported for testing only
 */
export const useReasoningGroupState = ({
  parts,
  isStreaming,
  isLastPartInMessage,
  hasTextInMessage,
}: UseReasoningGroupStateParams) => {
  const allItemsComplete = parts.every((item) => {
    const content = item.content as ToolUIPart | ReasoningUIPart
    return content.state === 'output-available' || content.state === 'output-error' || content.state === 'streaming'
  })

  const showLoadingNext = isStreaming && isLastPartInMessage && allItemsComplete && !hasTextInMessage

  const lastReasoningPart = useMemo<ReasoningUIPart | null>(() => {
    const lastPart = parts[parts.length - 1]

    if (lastPart && lastPart.type === 'reasoning') {
      return lastPart.content as ReasoningUIPart
    }

    return null
  }, [parts])

  return { lastReasoningPart, showLoadingNext, allItemsComplete }
}

type ReasoningGroupProps = {
  parts: ReasoningGroupItem[]
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextInMessage: boolean
  messageId: string
}

export const ReasoningGroup = ({
  parts,
  isStreaming,
  isLastPartInMessage,
  hasTextInMessage,
  messageId,
}: ReasoningGroupProps) => {
  const { openObjectSidebar } = useObjectView()

  const { lastReasoningPart } = useReasoningGroupState({
    parts,
    isStreaming,
    isLastPartInMessage,
    hasTextInMessage,
  })

  const { scrollContainerRef, scrollTargetRef, scrollHandlers } = useAutoScroll({
    dependencies: [lastReasoningPart?.text],
    isStreaming: lastReasoningPart?.state === 'streaming',
    smooth: false,
  })

  return (
    <div>
      <div className="*:data-[slot=avatar]:ring-background flex -space-x-2 -space-y-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:grayscale p-1 mt-6 mb-4 flex-wrap">
        {parts.map((item, index) => {
          if (item.type === 'tool') {
            const tool = item.content as ToolUIPart
            return (
              <ToolItem
                key={tool.toolCallId ?? `${tool.type}-${index}`}
                tool={tool}
                index={index}
                onOpenDetails={openObjectSidebar}
              />
            )
          }

          const reasoningPart = item.content as ReasoningUIPart
          return (
            <ReasoningItem
              key={`${messageId}_reasoning_${index}`}
              part={reasoningPart}
              index={index}
              messageId={messageId}
              onOpenDetails={openObjectSidebar}
            />
          )
        })}
      </div>
      <AnimatePresence>
        {lastReasoningPart?.state === 'streaming' && (
          <motion.div
            className="px-4 max-h-20 flex flex-1 overflow-scroll"
            initial={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            ref={scrollContainerRef}
            {...scrollHandlers}
          >
            <p className="text-muted-foreground text-sm ">{lastReasoningPart?.text}</p>
            <div ref={scrollTargetRef} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
