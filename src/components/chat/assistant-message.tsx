import {
  filterMessageParts,
  type GroupableUIPart,
  type GroupedUIPart,
  groupMessageParts,
  type ReasoningGroupUIPart,
} from '@/lib/assistant-message'
import { splitPartType } from '@/lib/utils'
import type { ThunderboltUIMessage } from '@/types'
import type { TextUIPart } from 'ai'
import { memo, type ReactNode } from 'react'
import { ReasoningGroup } from './reasoning-group'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'

type AssistantMessageProps = {
  message: ThunderboltUIMessage
  isStreaming: boolean
  isLastMessage?: boolean
}

// Viewport positioning constant - ensures enough space for scrolling user message to top
const lastMessageMinHeight = '72dvh'

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

/**
 * Converts grouped message parts into React elements for rendering.
 * Handles different part types (reasoning, tools, text) and manages loading states.
 * @internal - Exported for testing only
 */
export const mountMessageParts = (
  groupedParts: GroupedUIPart[],
  isStreaming: boolean,
  messageId: string,
  reasoningTime: Record<string, number>,
) => {
  const partElements: ReactNode[] = []

  if (groupedParts.length === 0 && isStreaming) {
    // isStreaming should always be true because the next part will *replace* this one
    partElements.push(<SyntheticLoadingPart isStreaming />)
  }

  const hasTextPart = groupedParts.some((part) => {
    const [partType] = splitPartType(part.type)
    return partType === 'text'
  })

  groupedParts.forEach((part, index) => {
    const [partType] = splitPartType(part.type)
    const isLastPart = index === groupedParts.length - 1

    switch (partType) {
      case 'reasoning_group': {
        const reasoningGroupPart = part as ReasoningGroupUIPart
        partElements.push(
          <ReasoningGroup
            parts={reasoningGroupPart.items}
            isStreaming={isStreaming}
            isLastPartInMessage={isLastPart}
            hasTextPart={hasTextPart}
            reasoningTime={reasoningTime}
          />,
        )
        break
      }
      case 'text':
        partElements.push(<TextPart part={part as TextUIPart} messageId={messageId} />)
        break
    }
  })

  return partElements
}

export const AssistantMessage = memo(({ message, isStreaming, isLastMessage = false }: AssistantMessageProps) => {
  const filteredParts = filterMessageParts(message.parts) as GroupableUIPart[]

  const groupedParts = groupMessageParts(filteredParts)

  const partElements: ReactNode[] = mountMessageParts(
    groupedParts,
    isStreaming,
    message.id,
    message.metadata?.reasoningTime ?? {},
  )

  return (
    <div data-message-id={message.id} style={isLastMessage ? { minHeight: lastMessageMinHeight } : undefined}>
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
