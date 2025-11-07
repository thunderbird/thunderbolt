import { type ReasoningGroupItem } from '@/lib/assistant-message'
import { Expandable } from '../ui/expandable'
import { CheckIcon, Loader2 } from 'lucide-react'
import { type ReasoningUIPart, type ToolUIPart } from 'ai'
import { ReasoningDisplay } from './reasoning-display'
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { ReasoningItem } from './reasoning-item'
import { ReasoningGroupTitle } from './reasoning-group-title'
import { useMemo } from 'react'

type ReasoningGroupProps = {
  parts: ReasoningGroupItem[]
  isStreaming: boolean
  isLastPartInMessage: boolean
}

export const ReasoningGroup = ({ parts, isStreaming, isLastPartInMessage }: ReasoningGroupProps) => {
  const tools = parts.filter((part) => part.type === 'tool').map((part) => part.content) as ToolUIPart[]

  const isThinking = isLastPartInMessage && isStreaming

  const lastPart = parts[parts.length - 1]

  const currentReasoningPart = lastPart.type === 'reasoning' ? (lastPart as ReasoningGroupItem<ReasoningUIPart>) : null

  // Create unique instance key for reasoning display
  const reasoningInstanceKey = currentReasoningPart
    ? `reasoning-${currentReasoningPart.content.text.substring(0, 50)}-${parts.indexOf(currentReasoningPart)}`
    : ''

  const totalDuration = useMemo(
    () =>
      parts.reduce((previous, current) => {
        return (previous + ((current.content as any).metadata?.duration ?? 0)) as number
      }, 0),
    [parts],
  )

  const { scrollContainerRef, scrollTargetRef } = useAutoScroll({
    dependencies: [parts.length],
    smooth: true,
    isStreaming: false,
    rootMargin: '0px',
  })

  return (
    <div className="mt-4">
      <Expandable
        className="shadow-none tool-invocation-card rounded-lg overflow-hidden transition-colors"
        icon={
          isThinking ? (
            <Loader2 className={`h-4 w-4 animate-spin text-blue-600 dark:text-blue-400`} />
          ) : (
            <CheckIcon className="h-4 w-4 text-green-600 dark:text-green-400" />
          )
        }
        defaultOpen={false}
        title={<ReasoningGroupTitle totalDuration={totalDuration} isThinking={isThinking} tools={tools} />}
      >
        <div
          className="max-h-[200px] overflow-y-auto"
          ref={(el) => {
            scrollContainerRef.current = el
          }}
        >
          {parts.map((part, index) => (
            <ReasoningItem key={index} part={part} />
          ))}
          <div ref={scrollTargetRef} />
        </div>
      </Expandable>
      {currentReasoningPart && (
        <ReasoningDisplay
          text={currentReasoningPart.content.text}
          isStreaming={currentReasoningPart.content.state === 'streaming'}
          instanceKey={reasoningInstanceKey}
        />
      )}
    </div>
  )
}
