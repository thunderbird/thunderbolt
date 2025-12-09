import { useObjectView } from '@/content-view/context'
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { type ReasoningGroupItem } from '@/lib/assistant-message'
import { type ReasoningUIPart, type ToolUIPart } from 'ai'
import { CheckIcon, Loader2 } from 'lucide-react'
import { Expandable } from '../ui/expandable'
import { ReasoningDisplay } from './reasoning-display'
import { ReasoningGroupTitle } from './reasoning-group-title'
import { ReasoningItem } from './reasoning-item'

type ReasoningGroupProps = {
  parts: ReasoningGroupItem[]
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextPart: boolean
  reasoningTime: Record<string, number>
}

export const ReasoningGroup = ({
  parts,
  isStreaming,
  isLastPartInMessage,
  hasTextPart,
  reasoningTime,
}: ReasoningGroupProps) => {
  const { openObjectSidebar } = useObjectView()

  const tools = parts.filter((part) => part.type === 'tool').map((part) => part.content) as ToolUIPart[]

  const currentReasoningPart = parts
    .filter((part) => part.type === 'reasoning')
    .pop() as ReasoningGroupItem<ReasoningUIPart> | null

  const isGroupReasoning = isLastPartInMessage && (isStreaming || currentReasoningPart?.content.state === 'streaming')

  // Create unique instance key for reasoning display
  const reasoningInstanceKey = currentReasoningPart
    ? `reasoning-${currentReasoningPart.content.text.substring(0, 50)}-${parts.indexOf(currentReasoningPart)}`
    : ''

  const totalDuration = Object.values(reasoningTime ?? {}).reduce((previous, current) => previous + current, 0)

  const { scrollContainerRef, scrollTargetRef } = useAutoScroll({
    dependencies: [parts.length],
    smooth: true,
    isStreaming: false,
    rootMargin: '0px',
  })

  return (
    <div className="mt-6">
      <Expandable
        className="shadow-none tool-invocation-card rounded-lg overflow-hidden transition-colors"
        icon={
          isGroupReasoning ? (
            <Loader2 className={`h-4 w-4 animate-spin text-muted-foreground`} />
          ) : (
            <CheckIcon className="h-4 w-4 text-muted-foreground" />
          )
        }
        defaultOpen={false}
        title={<ReasoningGroupTitle totalDuration={totalDuration} isGroupReasoning={isGroupReasoning} tools={tools} />}
      >
        <div
          className="max-h-[200px] overflow-y-auto"
          ref={(el) => {
            scrollContainerRef.current = el
          }}
        >
          {parts.map((part, index) => {
            return (
              <ReasoningItem
                key={index}
                part={part}
                onClick={() => openObjectSidebar(part.content as ToolUIPart | ReasoningUIPart)}
                reasoningTime={reasoningTime?.[part.id]}
                isGroupReasoning={isGroupReasoning}
              />
            )
          })}
          <div ref={scrollTargetRef} />
        </div>
      </Expandable>
      {!hasTextPart && (
        <ReasoningDisplay
          text={currentReasoningPart?.content.text}
          isStreaming={currentReasoningPart?.content.state === 'streaming'}
          instanceKey={reasoningInstanceKey}
        />
      )}
    </div>
  )
}
