import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useContentView } from '@/content-view/context'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import type { ReasoningUIPart, ToolUIPart } from 'ai'
import { Brain, Check, Clock, Zap } from 'lucide-react'
import { useRef } from 'react'
import { Expandable } from '../ui/expandable'

export type StepInfo = {
  type: 'tool' | 'reasoning'
  name: string
  args?: any
  status: 'running' | 'success' | 'error'
  startTime: number
  endTime: number
  part: ToolUIPart | ReasoningUIPart
}

export type ToolsSummaryPartProps = {
  toolCount: number
  duration: number // in milliseconds
  tools?: StepInfo[]
}

const formatDuration = (ms: number): string => {
  const seconds = ms / 1000
  if (seconds < 1) {
    return `${Math.round(ms)}ms`
  }
  return `${seconds.toFixed(1)}s`
}

export const ToolsSummaryPart = ({ toolCount, duration, tools = [] }: ToolsSummaryPartProps) => {
  const { showObjectView } = useContentView()
  const timelineContainerRef = useRef<HTMLDivElement>(null)

  const { scrollContainerRef, scrollTargetRef } = useAutoScroll({
    dependencies: [tools.length],
    smooth: true,
    isStreaming: false,
    rootMargin: '0px',
  })

  const icon = <Check className="h-4 w-4 text-green-600 dark:text-green-400" />

  const title = (
    <span className="flex items-center gap-2">
      <span>
        Used {toolCount} tool{toolCount !== 1 ? 's' : ''} in {formatDuration(duration)}
      </span>
    </span>
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
      className="shadow-none tool-summary-card rounded-lg overflow-hidden transition-colors"
      icon={icon}
      defaultOpen={false}
      title={title}
    >
      <div
        ref={(el) => {
          scrollContainerRef.current = el
          timelineContainerRef.current = el
        }}
        className="max-h-[400px] overflow-y-auto space-y-3"
      >
        {tools.length > 0 ? (
          <div className="relative">
            {tools.map((step, index) => {
              const stepDuration = step.endTime - step.startTime
              let displayName = step.name
              let icon = null

              if (step.type === 'tool') {
                const metadata = getToolMetadataSync(step.name, step.args)
                displayName = metadata?.displayName || step.name
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
            <div ref={scrollTargetRef} />
          </div>
        ) : (
          <div className="space-y-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Clock className="h-3 w-3" />
              <span>Total execution time: {formatDuration(duration)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Zap className="h-3 w-3" />
              <span>
                {toolCount} tool invocation{toolCount !== 1 ? 's' : ''} completed
              </span>
            </div>
          </div>
        )}
      </div>
    </Expandable>
  )
}
