import { type ReasoningGroupItem } from '@/lib/assistant-message'
import { Expandable } from '../ui/expandable'
import { CheckIcon, Loader2 } from 'lucide-react'
import { type ReasoningUIPart, type ToolUIPart } from 'ai'
import { ReasoningDisplay } from './reasoning-display'
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { ReasoningItem } from './reasoning-item'
import { ReasoningGroupTitle } from './reasoning-group-title'
import { useEffect, useState } from 'react'

type ReasoningGroupProps = {
  parts: ReasoningGroupItem[]
  isStreaming: boolean
  isLastPartInMessage: boolean
}

/**
 * Hook to calculate total duration from all parts
 * Handles both existing durations from metadata (old messages) and live tracking
 */
const useTotalDuration = (parts: ReasoningGroupItem[]) => {
  // Track durations by part index
  const [durations, setDurations] = useState<Map<number, number>>(new Map())

  // Initialize durations from metadata for old messages
  // Only set if we don't already have a duration for that index (live updates take precedence)
  useEffect(() => {
    setDurations((prev) => {
      const next = new Map(prev)
      let hasChanges = false

      parts.forEach((part, index) => {
        // Only initialize from metadata if we don't already have a duration for this index
        if (!next.has(index)) {
          const existingDuration = (part as any).metadata?.duration
          if (existingDuration !== undefined) {
            next.set(index, existingDuration)
            hasChanges = true
          }
        }
      })

      return hasChanges ? next : prev
    })
  }, [])

  /**
   * Updates duration for a specific part index
   */
  const updateDuration = (index: number, duration: number) => {
    setDurations((prev) => {
      const next = new Map(prev)
      next.set(index, duration)
      return next
    })
  }

  // Calculate total duration (sum of all individual durations)
  const totalDuration = Array.from(durations.values()).reduce((sum, duration) => sum + duration, 0)

  return { totalDuration, updateDuration }
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

  const { totalDuration, updateDuration } = useTotalDuration(parts)

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
        defaultOpen={true}
        title={<ReasoningGroupTitle totalDuration={totalDuration} isThinking={isThinking} tools={tools} />}
      >
        <div
          className="max-h-[200px] overflow-y-auto"
          ref={(el) => {
            scrollContainerRef.current = el
          }}
        >
          {parts.map((part, index) => (
            <ReasoningItem
              key={index}
              onChangeDuration={(duration) => {
                updateDuration(index, duration)
              }}
              part={part}
            />
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
