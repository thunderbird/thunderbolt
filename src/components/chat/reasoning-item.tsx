import { type ReasoningGroupItem } from '@/lib/assistant-message'
import { Brain, DotIcon, Loader2 } from 'lucide-react'
import { formatDuration, splitPartType } from '@/lib/utils'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { type ReasoningUIPart, type ToolUIPart } from 'ai'
import { useEffect, useRef, useState } from 'react'
import { useObjectView } from '@/content-view/context'

type ReasoningItemProps = {
  part: ReasoningGroupItem
  onChangeDuration(duration: number): void
}

/**
 * Checks if a part is completed (no longer loading)
 */
const isPartCompleted = (part: ReasoningGroupItem): boolean => {
  if (part.type === 'tool') {
    const toolPart = part.content as ToolUIPart
    return toolPart.state === 'output-available' || toolPart.state === 'output-error'
  }
  // For reasoning, consider it completed when not streaming
  const reasoningPart = part.content as ReasoningUIPart
  return reasoningPart.state !== 'streaming'
}

const useDurationTracker = ({ onChangeDuration, part }: ReasoningItemProps) => {
  // Check if duration already exists in metadata (for older messages)
  const existingDuration = (part as any).metadata?.duration
  const [duration, setDuration] = useState<number | undefined>(existingDuration)

  // Track start time when part first appears and is not completed
  const startTimeRef = useRef<number | null>(null)
  // Track if we've already calculated duration (once completed, it will never be triggered again)
  const hasCalculatedDurationRef = useRef<boolean>(!!existingDuration)
  // Track previous completion state to detect transitions
  const previousCompletedRef = useRef<boolean>(isPartCompleted(part))

  // Track execution duration
  useEffect(() => {
    // If duration already exists or has been calculated, don't track again
    if (hasCalculatedDurationRef.current) {
      return
    }

    const isCompleted = isPartCompleted(part)
    const now = Date.now()

    // If part just started (not completed and no start time recorded), record start time
    if (!isCompleted && startTimeRef.current === null) {
      startTimeRef.current = now
      previousCompletedRef.current = false
      return
    }

    // If part just transitioned from incomplete to complete, calculate duration
    if (!previousCompletedRef.current && isCompleted && startTimeRef.current !== null) {
      const calculatedDuration = now - startTimeRef.current
      setDuration(calculatedDuration)
      onChangeDuration(calculatedDuration)
      hasCalculatedDurationRef.current = true
    }

    previousCompletedRef.current = isCompleted
  }, [part])

  return duration
}

const getItemData = (part: ReasoningGroupItem) => {
  switch (part.type) {
    case 'reasoning': {
      const reasoningPart = part.content as ReasoningUIPart

      return {
        Icon: Brain,
        displayName: 'Thinking',
        isLoading: reasoningPart.state === 'streaming',
      }
    }

    case 'tool': {
      const toolPart = part.content as ToolUIPart
      const [, toolName] = splitPartType(toolPart.type)
      const metadata = getToolMetadataSync(toolName)

      return {
        Icon: metadata.icon || DotIcon,
        displayName: metadata.displayName,
        isLoading: toolPart.state !== 'output-available' && toolPart.state !== 'output-error',
      }
    }

    default:
      return null
  }
}

export const ReasoningItem = ({ onChangeDuration, part }: ReasoningItemProps) => {
  const duration = useDurationTracker({ onChangeDuration, part })

  const itemData = getItemData(part)

  const { openObjectSidebar } = useObjectView()

  if (!itemData) {
    return null
  }

  const Icon = itemData.Icon

  return (
    <button
      onClick={() => openObjectSidebar(part.content as ToolUIPart | ReasoningUIPart)}
      className="flex items-center w-full py-2 px-3 hover:bg-accent/50 rounded-md transition-colors group text-left"
    >
      <div className="flex gap-3 flex-row flex-1 items-center">
        {itemData.isLoading ? (
          <Loader2 className={`h-4 w-4 animate-spin text-blue-600 dark:text-blue-400`} />
        ) : (
          !!Icon && <Icon className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium truncate text-foreground">{itemData.displayName}</span>
      </div>
      <span className="text-xs text-muted-foreground flex-shrink-0">
        {duration ? formatDuration(duration) : itemData.isLoading ? '...' : '—'}
      </span>
    </button>
  )
}
