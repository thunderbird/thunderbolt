import {
  filterMessageParts,
  type GroupableUIPart,
  type GroupedUIPart,
  groupMessageParts,
  type ReasoningGroupUIPart,
} from '@/lib/assistant-message'
import { extractTextFromParts } from '@/lib/message-utils'
import { splitPartType } from '@/lib/utils'
import type { ThunderboltUIMessage } from '@/types'
import type { SourceMetadata } from '@/types/source'
import type { TextUIPart } from 'ai'
import { memo, useMemo, type ReactNode } from 'react'
import { CopyMessageButton } from './copy-message-button'
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
  reasoningStartTimes?: Record<string, number>,
  sources?: SourceMetadata[],
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
            reasoningStartTimes={reasoningStartTimes}
          />,
        )
        break
      }
      case 'text':
        partElements.push(<TextPart part={part as TextUIPart} messageId={messageId} sources={sources} />)
        break
    }
  })

  return partElements
}

export const AssistantMessage = memo(
  ({ message, isStreaming, isLastMessage = false }: AssistantMessageProps) => {
    // Memoize filtering and grouping to avoid recomputing on every render
    const groupedParts = useMemo(() => {
      const filtered = filterMessageParts(message.parts) as GroupableUIPart[]
      return groupMessageParts(filtered)
    }, [message.parts])

    // Stabilize metadata references to prevent unnecessary re-renders
    // Uses JSON.stringify for deep comparison since metadata objects may have new references
    const reasoningTime = useMemo(
      () => message.metadata?.reasoningTime ?? {},
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [JSON.stringify(message.metadata?.reasoningTime)],
    )

    const reasoningStartTimes = useMemo(
      () => message.metadata?.reasoningStartTimes,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [JSON.stringify(message.metadata?.reasoningStartTimes)],
    )

    const sources = useMemo(
      () => message.metadata?.sources,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [JSON.stringify(message.metadata?.sources)],
    )

    // Memoize part element creation to prevent recreating React nodes unnecessarily
    const partElements: ReactNode[] = useMemo(
      () => mountMessageParts(groupedParts, isStreaming, message.id, reasoningTime, reasoningStartTimes, sources),
      [groupedParts, isStreaming, message.id, reasoningTime, reasoningStartTimes, sources],
    )

    const copyText = useMemo(() => extractTextFromParts(message.parts), [message.parts])

    const hasWidgets = useMemo(
      () =>
        message.parts.some((part) => part.type === 'text' && /<widget:(weather-forecast|link-preview)/.test(part.text)),
      [message.parts],
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
        {!isStreaming && copyText && !hasWidgets && (
          <div className="flex items-center gap-2.5 px-4 -mt-6">
            <CopyMessageButton text={copyText} />
          </div>
        )}
      </div>
    )
  },
  // Custom comparison to prevent re-renders when content hasn't actually changed
  (prevProps, nextProps) => {
    return (
      prevProps.message.id === nextProps.message.id &&
      prevProps.message.parts === nextProps.message.parts &&
      prevProps.message.metadata === nextProps.message.metadata &&
      prevProps.isStreaming === nextProps.isStreaming &&
      prevProps.isLastMessage === nextProps.isLastMessage
    )
  },
)

AssistantMessage.displayName = 'AssistantMessage'
