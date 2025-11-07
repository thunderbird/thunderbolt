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
import { memo, useEffect, useRef, type ReactNode } from 'react'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'
import { ReasoningGroup } from './reasoning-group'
import { updateMessage } from '@/dal'

interface AssistantMessageProps {
  message: ThunderboltUIMessage
  isStreaming: boolean
}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

/**
 * Converts grouped message parts into React elements for rendering.
 * Handles different part types (reasoning, tools, text) and manages loading states.
 * @internal - Exported for testing only
 */
export const mountMessageParts = (groupedParts: GroupedUIPart[], isStreaming: boolean, messageId: string) => {
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
      case 'reasoning_group': {
        const reasoningGroupPart = part as ReasoningGroupUIPart
        partElements.push(
          <ReasoningGroup
            parts={reasoningGroupPart.items}
            isStreaming={isStreaming}
            isLastPartInMessage={isLastPart}
            hasTextPart={hasTextPart}
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

const useTrackMessagePartDuration = (parts: any[]) => {
  const partsStartTimes = useRef(new Map<number, number>())
  const partsEndTimes = useRef(new Map<number, number>())

  useEffect(() => {
    parts.forEach((part, index) => {
      const isPartStreaming =
        part.state !== 'done' && part.state !== 'output-available' && part.state !== 'output-error'

      if (isPartStreaming && !partsStartTimes.current.has(index)) {
        partsStartTimes.current.set(index, Date.now())
      }

      if (!isPartStreaming && !partsEndTimes.current.has(index)) {
        partsEndTimes.current.set(index, Date.now())
      }
    })
  }, [parts])

  return parts.map((item, index) => {
    const startTime = partsStartTimes.current.get(index)
    const endTime = partsEndTimes.current.get(index)
    const duration = endTime && startTime ? endTime - startTime : null

    const [partType] = splitPartType(item.type)

    return {
      ...item,
      ...(['tool', 'reasoning'].includes(partType) && duration
        ? {
            metadata: {
              ...(item as any).metadata,
              duration,
            },
          }
        : {}),
    }
  })
}

type UseSaveMessagePartsDurationParams = {
  isStreaming: boolean
  message: ThunderboltUIMessage
  updatedParts: any[]
}

const useSaveMessagePartsDuration = ({ isStreaming, message, updatedParts }: UseSaveMessagePartsDurationParams) => {
  const refIsStreaming = useRef(isStreaming)

  useEffect(() => {
    if (refIsStreaming.current && !isStreaming) {
      refIsStreaming.current = false

      // delay the update to ensure the parts are updated in the database
      const timeout = setTimeout(async () => {
        await updateMessage(message.id, { parts: updatedParts })
      }, 500)

      return () => clearTimeout(timeout)
    }
  }, [isStreaming, message, updatedParts])
}

export const AssistantMessage = memo(({ message, isStreaming }: AssistantMessageProps) => {
  const partsWithDuration = useTrackMessagePartDuration(message.parts)

  useSaveMessagePartsDuration({ isStreaming, message, updatedParts: partsWithDuration })

  const filteredParts = filterMessageParts(partsWithDuration) as GroupableUIPart[]

  const groupedParts = groupMessageParts(filteredParts)

  const partElements: ReactNode[] = mountMessageParts(groupedParts, isStreaming, message.id)

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
