import {
  filterMessageParts,
  type GroupableUIPart,
  type GroupedUIPart,
  groupToolParts,
  type ToolGroupUIPart,
} from '@/lib/assistant-message'
import { splitPartType } from '@/lib/utils'
import type { TextUIPart, ToolUIPart, UIMessage } from 'ai'
import { memo, type ReactNode } from 'react'
import { DisplayToolHandler } from './display-tool-handler'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'
import { ToolGroup } from './tool-group'

interface AssistantMessageProps {
  message: UIMessage
  isStreaming: boolean
}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

/**
 * Converts grouped message parts into React elements for rendering.
 * Handles different part types (reasoning, tools, text) and manages loading states.
 * @internal - Exported for testing only
 */
export const mountMessageParts = (groupedParts: GroupedUIPart[], isStreaming: boolean) => {
  const partElements: ReactNode[] = []

  if (groupedParts.length === 0) {
    // isStreaming should always be true because the next part will *replace* this one
    partElements.push(<SyntheticLoadingPart isStreaming={true} />)
  }

  const hasTextPart = groupedParts.some((part) => {
    const [partType] = splitPartType(part.type)
    return partType === 'text'
  })

  groupedParts.forEach((part, index) => {
    const [partType] = splitPartType(part.type)
    const isLastPart = index === groupedParts.length - 1

    switch (partType) {
      case 'group_tools': {
        const toolGroup = part as ToolGroupUIPart
        partElements.push(
          <ToolGroup
            tools={toolGroup.tools}
            parts={toolGroup.parts}
            isStreaming={isStreaming}
            isLastPartInMessage={isLastPart}
            hasTextInMessage={hasTextPart}
          />,
        )
        break
      }
      case 'tool':
        partElements.push(<DisplayToolHandler part={part as ToolUIPart} />)
        break
      case 'text':
        partElements.push(<TextPart part={part as TextUIPart} />)
        break
    }
  })

  return partElements
}

export const AssistantMessage = memo(({ message, isStreaming }: AssistantMessageProps) => {
  const filteredParts = filterMessageParts(message.parts) as GroupableUIPart[]

  const groupedParts = groupToolParts(filteredParts)

  const partElements: ReactNode[] = mountMessageParts(groupedParts, isStreaming)

  return (
    <div>
      {partElements.map((partElement, index) => (
        // Skip the animation on the *second* (index === 1) partElement so that it replaces the loading part *in-place* without an animation
        // This causes it to appear as if the loading part magically *becomes* the new part without any visual disruption
        <div key={index} className={index === 1 ? '' : animationClasses}>
          {partElement}
        </div>
      ))}
    </div>
  )
})
