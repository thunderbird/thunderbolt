import { splitPartType } from '@/lib/utils'
import type { UIMessage, ReasoningUIPart, TextUIPart, ToolUIPart } from 'ai'
import { memo, type ReactNode } from 'react'
import { DisplayToolHandler } from './display-tool-handler'
import { ReasoningPart } from './reasoning-part'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'
import { ToolGroup } from './tool-group'
import {
  filterMessageParts,
  type GroupableUIPart,
  groupToolParts,
  type ToolGroupUIPart,
  type GroupedUIPart,
} from '@/lib/assistant-message'

interface AssistantMessageProps {
  message: UIMessage
  isStreaming: boolean // @todo legacy - can remove this
}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

const mountMessageParts = (groupedParts: GroupedUIPart[]) => {
  const partElements: ReactNode[] = []

  if (groupedParts.length === 0) {
    // isStreaming should always be true because the next part will *replace* this one
    partElements.push(<SyntheticLoadingPart isStreaming={true} />)
  }

  groupedParts.forEach((part) => {
    const [partType] = splitPartType(part.type)

    switch (partType) {
      case 'reasoning':
        partElements.push(<ReasoningPart part={part as ReasoningUIPart} />)
        break
      case 'group_tools':
        partElements.push(<ToolGroup tools={(part as ToolGroupUIPart).tools} />)
        break
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

export const AssistantMessage = memo(({ message }: AssistantMessageProps) => {
  const filteredParts = filterMessageParts(message.parts) as GroupableUIPart[]

  const groupedParts = groupToolParts(filteredParts)

  const partElements: ReactNode[] = mountMessageParts(groupedParts)

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
