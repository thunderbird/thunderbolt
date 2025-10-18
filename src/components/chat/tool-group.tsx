import type { ReasoningUIPart, ToolUIPart } from 'ai'
import { Brain } from 'lucide-react'
import { motion } from 'framer-motion'
import { useObjectView } from './object-view-provider'
import { ToolIcon } from './tool-icon'
import { ToolItem } from './tool-item'
import { getMessagePartOutput, splitPartType } from '@/lib/utils'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useThinkingPopover } from '@/hooks/use-thinking-popover'

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
    <Tooltip>
      <TooltipTrigger asChild>
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
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="font-medium">Thinking</p>
      </TooltipContent>
    </Tooltip>
  )
}

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

  const { isPopoverOpen, displayReasoningPart, popoverStyle } = useThinkingPopover({
    parts,
  })

  const { scrollContainerRef, scrollTargetRef, scrollHandlers } = useAutoScroll({
    dependencies: [displayReasoningPart?.text],
    isStreaming: displayReasoningPart?.state === 'streaming',
    smooth: false,
  })

  return (
    <Popover open={isPopoverOpen}>
      <PopoverAnchor>
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
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        className="PopoverContent max-w-md transition-[margin] duration-300 ease-in-out"
        style={popoverStyle}
      >
        <div className="max-h-40 overflow-scroll" ref={scrollContainerRef} {...scrollHandlers}>
          <p className="font-medium">Thinking</p>
          <p className="text-gray-700 dark:text-gray-300 text-sm whitespace-pre-wrap">
            {displayReasoningPart?.text || ''}
          </p>
          <div ref={scrollTargetRef} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
