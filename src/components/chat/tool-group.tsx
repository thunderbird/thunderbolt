import type { ReasoningUIPart, ToolUIPart } from 'ai'
import { Brain } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useObjectView } from './object-view-provider'
import { ToolIcon } from './tool-icon'
import { ToolItem } from './tool-item'
import { getMessagePartOutput, splitPartType } from '@/lib/utils'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'
import { useMemo, memo } from 'react'

type UseToolGroupStateParams = {
  tools: ToolUIPart[]
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextInMessage: boolean
}

type ReasoningPartProps = {
  part: ReasoningUIPart
  index: number
  onOpenDetails: () => void
}

const ReasoningPart = ({ part: _part, index, onOpenDetails }: ReasoningPartProps) => {
  return (
    <motion.div
      key={`reasoning-${index}`}
      className="data-[slot=avatar]:ring-background data-[slot=avatar]:ring-2 data-[slot=avatar]:grayscale"
      initial={{ scale: 0 }}
      animate={{
        scale: 1,
      }}
    >
      <ToolIcon
        toolName="reasoning"
        toolOutput=""
        Icon={Brain}
        initials=""
        isLoading={false}
        isError={false}
        tooltipKey={`reasoning-${index}`}
        onClick={onOpenDetails}
      />
    </motion.div>
  )
}

type ReasoningPopoverProps = {
  streamingReasoningPart: ReasoningUIPart | undefined
  streamingReasoningIndex: number
  popoverStyle: React.CSSProperties
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  scrollTargetRef: React.RefObject<HTMLDivElement | null>
  scrollHandlers: {
    onScroll: () => void
    onWheel: (e: React.WheelEvent) => void
  }
}

const ReasoningPopover = memo(
  ({
    streamingReasoningPart,
    streamingReasoningIndex,
    popoverStyle,
    scrollContainerRef,
    scrollTargetRef,
    scrollHandlers,
  }: ReasoningPopoverProps) => {
    return (
      <AnimatePresence mode="wait">
        {streamingReasoningPart && (
          <motion.div
            key={`popover-${streamingReasoningIndex}`}
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{
              duration: 0.2,
              ease: 'easeOut',
            }}
            className={cn(
              '-mt-4 absolute z-50 max-w-lg rounded-md border bg-popover p-4 text-popover-foreground shadow-md',
              'will-change-transform', // Hint browser for GPU acceleration
            )}
            style={popoverStyle}
            ref={scrollContainerRef}
            {...scrollHandlers}
          >
            <div className="max-h-40 overflow-scroll">
              <p className="font-medium">Thinking</p>
              <p className="text-gray-700 dark:text-gray-300 text-sm whitespace-pre-wrap">
                {streamingReasoningPart.text}
              </p>
              <div ref={scrollTargetRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    )
  },
)

/**
 * Computes the display state for a tool group, including completion status
 * and whether to show a loading indicator for the next action.
 * @internal - Exported for testing only
 */
export const useToolGroupState = ({
  tools,
  isStreaming,
  isLastPartInMessage,
  hasTextInMessage,
}: UseToolGroupStateParams) => {
  const allToolsComplete = tools.every((tool) => tool.state === 'output-available' || tool.state === 'output-error')

  const showLoadingNext = isStreaming && isLastPartInMessage && allToolsComplete && !hasTextInMessage

  return { showLoadingNext, allToolsComplete }
}

type ToolGroupProps = {
  tools: ToolUIPart[]
  parts: (ToolUIPart | ReasoningUIPart)[]
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextInMessage: boolean
}

export const ToolGroup = ({ tools, parts, isStreaming, isLastPartInMessage, hasTextInMessage }: ToolGroupProps) => {
  const { openObjectSidebar } = useObjectView()

  const { showLoadingNext } = useToolGroupState({
    tools,
    isStreaming,
    isLastPartInMessage,
    hasTextInMessage,
  })

  // Memoize the streaming reasoning part to prevent unnecessary re-renders
  const streamingReasoningData = useMemo(() => {
    const index = parts.findIndex((part) => part.type === 'reasoning' && part.state === 'streaming')
    return {
      index,
      part: index !== -1 ? (parts[index] as ReasoningUIPart) : undefined,
    }
  }, [parts])

  const { index: streamingReasoningIndex, part: streamingReasoningPart } = streamingReasoningData

  const { scrollContainerRef, scrollTargetRef, scrollHandlers } = useAutoScroll({
    dependencies: [streamingReasoningPart?.text],
    isStreaming: !!streamingReasoningPart,
    smooth: false, // Disable smooth scrolling during streaming to reduce lag
  })

  const isMobile = useIsMobile()

  // Memoize the left position calculation to prevent style recalculations
  const popoverStyle = useMemo(
    () => ({
      left: isMobile ? '0' : `calc(${streamingReasoningIndex * 32}px + 4px)`,
    }),
    [streamingReasoningIndex, isMobile],
  )

  return (
    <div className="relative">
      <div className="*:data-[slot=avatar]:ring-background flex -space-x-2 -space-y-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:grayscale p-1 mt-6 mb-4 flex-wrap">
        {parts.map((part, index) => {
          if (part.type === 'reasoning') {
            return (
              <ReasoningPart
                key={`reasoning-${index}`}
                part={part}
                index={index}
                onOpenDetails={() =>
                  openObjectSidebar({
                    content: part.text,
                    title: 'Thinking',
                  })
                }
              />
            )
          } else {
            const tool = part as ToolUIPart

            const [, toolName] = splitPartType(tool.type)
            const metadata = getToolMetadataSync(toolName, tool.input)

            return (
              <ToolItem
                key={tool.toolCallId ?? `${tool.type}-${index}`}
                tool={tool}
                index={index}
                onOpenDetails={() =>
                  openObjectSidebar({
                    content: getMessagePartOutput(tool),
                    title: metadata.displayName,
                  })
                }
              />
            )
          }
        })}
        {showLoadingNext && (
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.div
                initial={{ scale: 0 }}
                animate={{
                  scale: 1,
                }}
              >
                <ToolIcon
                  toolName="processing"
                  toolOutput={undefined}
                  Icon={null}
                  initials="..."
                  isLoading={true}
                  isError={false}
                  tooltipKey="next-action-loading"
                  onClick={() => {}}
                />
              </motion.div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium">Thinking...</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Custom popover for reasoning parts */}
      <ReasoningPopover
        streamingReasoningPart={streamingReasoningPart}
        streamingReasoningIndex={streamingReasoningIndex}
        popoverStyle={popoverStyle}
        scrollContainerRef={scrollContainerRef}
        scrollTargetRef={scrollTargetRef}
        scrollHandlers={scrollHandlers}
      />
    </div>
  )
}
