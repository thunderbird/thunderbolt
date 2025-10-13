import type { ToolUIPart } from 'ai'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '../ai-elements/chain-of-thought'
import { Loader } from '../ai-elements/loader'
import { AnimatePresence } from 'framer-motion'
import { ToolItem } from './tool-item'

type ToolGroupProps = {
  tools: ToolUIPart[]
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextInMessage: boolean
}

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

export const ToolGroup = ({ tools, isStreaming, isLastPartInMessage, hasTextInMessage }: ToolGroupProps) => {
  const { showLoadingNext } = useToolGroupState({
    tools,
    isStreaming,
    isLastPartInMessage,
    hasTextInMessage,
  })

  return (
    <AnimatePresence>
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader />
        <ChainOfThoughtContent>
          {tools.map((tool) => (
            <ToolItem tool={tool} />
          ))}
          {showLoadingNext && (
            <ChainOfThoughtStep
              // @ts-ignore
              icon={Loader}
              status="pending"
            />
          )}
        </ChainOfThoughtContent>
      </ChainOfThought>
    </AnimatePresence>
  )
}
