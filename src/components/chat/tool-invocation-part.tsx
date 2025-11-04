import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useContentView } from '@/content-view/context'
import { getToolMetadata, getToolMetadataSync } from '@/lib/tool-metadata'
import { splitPartType } from '@/lib/utils'
import { useQuery } from '@tanstack/react-query'
import type { ReasoningUIPart, ToolUIPart } from 'ai'
import { Brain, Check, Loader2, X } from 'lucide-react'
import { memo, useRef } from 'react'
import { Expandable } from '../ui/expandable'
import type { StepInfo } from './tools-summary-part'

export type ToolInvocationPartProps = {
  part: ToolUIPart
  isStreaming: boolean
  allSteps: StepInfo[]
  isMessageStreaming: boolean // Whether the entire message is still streaming
}

const getToolIcon = (state: ToolUIPart['state'], isMessageStreaming: boolean) => {
  const baseClass = 'h-4 w-4 flex-shrink-0'
  const spinnerClass = 'h-3.5 w-3.5 flex-shrink-0'

  // If the overall message is still streaming, show loading spinner even if this tool completed
  if (isMessageStreaming) {
    return <Loader2 className={`${spinnerClass} animate-spin text-blue-600 dark:text-blue-400`} />
  }

  // Only show completion states when the entire message is done
  switch (state) {
    default:
    case 'input-streaming':
    case 'input-available':
      return <Loader2 className={`${spinnerClass} animate-spin text-blue-600 dark:text-blue-400`} />
    case 'output-available':
      return <Check className={`${baseClass} text-green-600 dark:text-green-400`} />
    case 'output-error':
      return <X className={`${baseClass} text-red-600 dark:text-red-400`} />
  }
}

const formatDuration = (ms: number): string => {
  const seconds = ms / 1000
  if (seconds < 1) {
    return `${Math.round(ms)}ms`
  }
  return `${seconds.toFixed(1)}s`
}

export const ToolInvocationPart = memo(({ part, allSteps, isMessageStreaming }: ToolInvocationPartProps) => {
  const { type, input, state } = part
  const [, toolName] = splitPartType(type)
  const { showObjectView } = useContentView()
  const timelineContainerRef = useRef<HTMLDivElement>(null)

  const { scrollContainerRef, scrollTargetRef } = useAutoScroll({
    dependencies: [allSteps.length],
    smooth: true,
    isStreaming: false,
    rootMargin: '0px',
  })

  // Use react-query to fetch metadata with proper caching
  const { data: metadata } = useQuery({
    queryKey: ['tool-metadata', toolName, JSON.stringify(input)],
    queryFn: async () => {
      const result = await getToolMetadata(toolName, input)
      return result
    },
    // Use sync version as placeholder data for immediate rendering
    placeholderData: () => getToolMetadataSync(toolName, input),
    staleTime: Infinity, // Tool metadata doesn't change during runtime
  })

  const titleNode = metadata ? (
    <span className="flex items-center gap-2 overflow-hidden">
      <span className="flex-shrink-0">{metadata.displayName}</span>
      {(state === 'input-streaming' || state === 'input-available' || isMessageStreaming) && (
        <span className="text-xs text-blue-600 dark:text-blue-400 italic animate-pulse truncate min-w-0">
          {metadata.loadingMessage}
        </span>
      )}
    </span>
  ) : (
    'Loading...'
  )

  const handleStepClick = (step: StepInfo) => {
    if (step.type === 'tool') {
      showObjectView(step.part as ToolUIPart)
    } else if (step.type === 'reasoning') {
      // Create a synthetic "tool" part for reasoning to display in sidebar
      const reasoningPart = step.part as ReasoningUIPart
      const syntheticPart = {
        type: 'tool:reasoning',
        toolCallId: `reasoning-${step.startTime}`,
        state: 'output-available',
        input: {},
        output: reasoningPart.text,
      } as unknown as ToolUIPart
      showObjectView(syntheticPart)
    }
  }

  return (
    <Expandable
      className="shadow-none tool-invocation-card rounded-lg overflow-hidden transition-colors"
      icon={getToolIcon(state, isMessageStreaming)}
      defaultOpen={false}
      title={titleNode}
    >
      <div
        ref={(el) => {
          scrollContainerRef.current = el
          timelineContainerRef.current = el
        }}
        className="max-h-[400px] overflow-y-auto space-y-3"
      >
        <div className="relative">
          {allSteps.map((step, index) => {
            const stepDuration = step.endTime - step.startTime
            let displayName = step.name
            let icon = null

            if (step.type === 'tool') {
              const stepMetadata = getToolMetadataSync(step.name, step.args)
              displayName = stepMetadata?.displayName || step.name
            } else {
              displayName = 'Thinking'
              icon = <Brain className="h-3 w-3 text-blue-600 dark:text-blue-400" />
            }

            return (
              <button
                key={index}
                onClick={() => handleStepClick(step)}
                className="flex items-center gap-3 w-full py-2 px-3 hover:bg-accent/50 rounded-md transition-colors group text-left"
              >
                {/* Status Indicator */}
                <div className="flex-shrink-0">
                  {icon || (
                    <div
                      className={`w-2 h-2 rounded-full ${
                        step.status === 'success'
                          ? 'bg-green-500'
                          : step.status === 'error'
                            ? 'bg-red-500'
                            : 'bg-blue-500 animate-pulse'
                      }`}
                    />
                  )}
                </div>

                {/* Step Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate text-foreground">{displayName}</span>
                    {step.status !== 'running' && (
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {formatDuration(stepDuration)}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
        <div ref={scrollTargetRef} />
      </div>
    </Expandable>
  )
})
