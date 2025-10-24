import { useObjectView } from '@/content-view/context'
import type { ToolUIPart } from 'ai'
import { motion } from 'framer-motion'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { ToolIcon } from './tool-icon'
import { ToolItem } from './tool-item'

type UseToolGroupStateParams = {
  tools: ToolUIPart[]
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextInMessage: boolean
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
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextInMessage: boolean
}

export const ToolGroup = ({ tools, isStreaming, isLastPartInMessage, hasTextInMessage }: ToolGroupProps) => {
  const { openObjectSidebar } = useObjectView()

  const { showLoadingNext } = useToolGroupState({
    tools,
    isStreaming,
    isLastPartInMessage,
    hasTextInMessage,
  })

  return (
    <div className="*:data-[slot=avatar]:ring-background flex -space-x-2 -space-y-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:grayscale p-1 mt-6 mb-4 flex-wrap">
      {tools.map((tool, index) => (
        <ToolItem
          key={tool.toolCallId ?? `${tool.type}-${index}`}
          tool={tool}
          index={index}
          onOpenDetails={openObjectSidebar}
        />
      ))}
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
  )
}
