import { filterMessageParts, type GroupableUIPart } from '@/lib/assistant-message'
import { splitPartType } from '@/lib/utils'
import type { ThunderboltUIMessage } from '@/types'
import type { ReasoningUIPart, TextUIPart, ToolUIPart } from 'ai'
import { memo, useEffect, useRef, useState } from 'react'
import { ReasoningDisplay } from './reasoning-display'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'
import { ToolInvocationPart } from './tool-invocation-part'
import { ToolsSummaryPart } from './tools-summary-part'
import { StackedExpandables } from '../ui/stacked-expandables'

interface AssistantMessageProps {
  message: ThunderboltUIMessage
  isStreaming: boolean
}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

export const AssistantMessage = memo(({ message, isStreaming }: AssistantMessageProps) => {
  const filteredParts = filterMessageParts(message.parts) as GroupableUIPart[]
  const [toolsStartTime] = useState(() => Date.now())
  const toolsEndTimeRef = useRef<number | null>(null)
  const stepTimingsRef = useRef<
    Map<
      number,
      {
        type: 'tool' | 'reasoning'
        name: string
        args: unknown
        startTime: number
        endTime?: number
        part: ToolUIPart | ReasoningUIPart
      }
    >
  >(new Map())

  const partGroups: { expandables: React.ReactElement[]; others: React.ReactElement[]; hasTools: boolean }[] = []
  let currentGroup: { expandables: React.ReactElement[]; others: React.ReactElement[]; hasTools: boolean } = {
    expandables: [],
    others: [],
    hasTools: false,
  }

  // Show loading state when streaming with no parts at all
  if (filteredParts.length === 0 && isStreaming) {
    currentGroup.expandables.push(<SyntheticLoadingPart key="loading" isStreaming={true} />)
    currentGroup.hasTools = true
  }

  // Build allSteps array from timing data for passing to components
  const allSteps = Array.from(stepTimingsRef.current.entries())
    .map(([_, timing]) => {
      // Determine status based on the part state
      let status: 'running' | 'success' | 'error' = 'running'
      if (timing.type === 'tool') {
        const toolPart = timing.part as ToolUIPart
        if (toolPart.state === 'output-available') {
          status = 'success'
        } else if (toolPart.state === 'output-error') {
          status = 'error'
        }
      } else if (timing.type === 'reasoning') {
        const reasoningPart = timing.part as ReasoningUIPart
        if (reasoningPart.state === 'done') {
          status = 'success'
        }
      }

      return {
        type: timing.type,
        name: timing.name,
        args: timing.args,
        status,
        part: timing.part,
        startTime: timing.startTime,
        endTime: timing.endTime || Date.now(),
      }
    })
    .sort((a, b) => a.startTime - b.startTime)

  // Find the most recent reasoning part for displaying text below accordions
  // But only if there's no text part yet (hide reasoning when text starts streaming)
  let currentReasoningPart: ReasoningUIPart | null = null
  const hasTextPart = filteredParts.some((part) => {
    const [partType] = splitPartType(part.type)
    return partType === 'text'
  })

  if (!hasTextPart) {
    for (let i = filteredParts.length - 1; i >= 0; i--) {
      const part = filteredParts[i]
      const [partType] = splitPartType(part.type)
      if (partType === 'reasoning') {
        currentReasoningPart = part as ReasoningUIPart
        break
      }
    }
  }

  // Create unique instance key for reasoning display
  const reasoningInstanceKey = currentReasoningPart
    ? `reasoning-${currentReasoningPart.text.substring(0, 50)}-${filteredParts.indexOf(currentReasoningPart)}`
    : ''

  // Track tool indices for each group
  const toolIndicesByGroup: number[][] = []
  let currentToolIndices: number[] = []

  let hasAnyTools = false

  filteredParts.forEach((part, index) => {
    const [partType] = splitPartType(part.type)
    const isLastPart = index === filteredParts.length - 1
    const isPartStreaming = isStreaming && isLastPart

    switch (partType) {
      case 'reasoning': {
        // Don't render reasoning accordions - only track for timing and show text via ReasoningDisplay
        currentToolIndices.push(index)
        break
      }
      case 'tool': {
        hasAnyTools = true
        const element = (
          <ToolInvocationPart
            key={`${partType}-${index}`}
            part={part as ToolUIPart}
            isStreaming={isPartStreaming}
            allSteps={allSteps}
            isMessageStreaming={isStreaming}
          />
        )
        currentGroup.expandables.push(element)
        currentGroup.hasTools = true
        currentToolIndices.push(index)
        break
      }
      case 'text': {
        // If we have expandables, save current group and start a new one
        if (currentGroup.expandables.length > 0) {
          partGroups.push(currentGroup)
          toolIndicesByGroup.push(currentToolIndices)
          currentGroup = { expandables: [], others: [], hasTools: false }
          currentToolIndices = []
        }
        currentGroup.others.push(
          <TextPart key={`${partType}-${index}`} part={part as TextUIPart} messageId={message.id} />,
        )
        break
      }
    }
  })

  // Add loading state when streaming and no tools yet (only reasoning or nothing)
  if (isStreaming && !hasAnyTools && currentGroup.expandables.length === 0 && currentGroup.others.length === 0) {
    currentGroup.expandables.push(<SyntheticLoadingPart key="loading" isStreaming={true} />)
    currentGroup.hasTools = true
  }

  // Add the last group if it has content
  if (currentGroup.expandables.length > 0 || currentGroup.others.length > 0) {
    partGroups.push(currentGroup)
    toolIndicesByGroup.push(currentToolIndices)
  }

  // Check if all tools in all groups are completed
  const allToolsCompleted = filteredParts.every((part) => {
    const [partType] = splitPartType(part.type)
    if (partType === 'tool') {
      const toolPart = part as ToolUIPart
      return toolPart.state === 'output-available' || toolPart.state === 'output-error'
    }
    return true
  })

  // Count total tools
  const totalToolCount = filteredParts.filter((part) => {
    const [partType] = splitPartType(part.type)
    return partType === 'tool'
  }).length

  // Find the last tool index
  let lastToolIndex = -1
  filteredParts.forEach((part, index) => {
    const [partType] = splitPartType(part.type)
    if (partType === 'tool') {
      lastToolIndex = index
    }
  })

  // Check if we've streamed past all tools
  const currentStreamingIndex = filteredParts.length - 1
  const pastAllTools = lastToolIndex === -1 || currentStreamingIndex > lastToolIndex

  // Track individual step timings (tools and reasoning)
  useEffect(() => {
    filteredParts.forEach((part, index) => {
      const [partType] = splitPartType(part.type)

      if (partType === 'reasoning') {
        const reasoningPart = part as ReasoningUIPart
        const timing = stepTimingsRef.current.get(index)

        // Record start time when reasoning appears
        if (!timing) {
          stepTimingsRef.current.set(index, {
            type: 'reasoning',
            name: 'reasoning',
            args: {},
            part: reasoningPart,
            startTime: Date.now(),
          })
        } else {
          // Update the part reference to get latest state
          timing.part = reasoningPart
        }

        // Record end time when reasoning completes
        if (timing && !timing.endTime && reasoningPart.state === 'done') {
          timing.endTime = Date.now()
        }
      } else if (partType === 'tool') {
        const toolPart = part as ToolUIPart
        const [, toolName] = splitPartType(toolPart.type)
        const timing = stepTimingsRef.current.get(index)

        // Record start time when tool appears
        if (!timing) {
          stepTimingsRef.current.set(index, {
            type: 'tool',
            name: toolName,
            args: toolPart.input,
            part: toolPart,
            startTime: Date.now(),
          })
        } else {
          // Update the part reference to get latest state and output
          timing.part = toolPart
        }

        // Record end time when tool completes
        if (timing && !timing.endTime && (toolPart.state === 'output-available' || toolPart.state === 'output-error')) {
          timing.endTime = Date.now()
        }
      }
    })
  }, [filteredParts])

  // Capture the end time when all tools are completed and we've moved past them
  useEffect(() => {
    if (allToolsCompleted && pastAllTools && totalToolCount > 0 && !toolsEndTimeRef.current) {
      toolsEndTimeRef.current = Date.now()
    }
  }, [allToolsCompleted, pastAllTools, totalToolCount])

  return (
    <div className="mt-4">
      {partGroups.map((group, groupIndex) => {
        // Check if this is the last group with tools
        const isLastToolGroup = group.hasTools && partGroups.slice(groupIndex + 1).every((g) => !g.hasTools)

        // Show summary ONLY when:
        // 1. This is the last group with tools
        // 2. All tools are completed (have results)
        // 3. We've streamed past all tool invocations
        // 4. The message is NOT streaming (completely done)
        const shouldShowSummary =
          isLastToolGroup && allToolsCompleted && totalToolCount > 0 && pastAllTools && !isStreaming

        return (
          <div key={groupIndex}>
            {group.expandables.length > 0 && (
              <StackedExpandables className={groupIndex === 0 ? animationClasses : ''}>
                {[
                  ...group.expandables,
                  // Add tools summary only to the last group with tools, when message is completely done
                  ...(shouldShowSummary
                    ? [
                        <ToolsSummaryPart
                          key="tools-summary"
                          toolCount={totalToolCount}
                          duration={(toolsEndTimeRef.current || Date.now()) - toolsStartTime}
                          tools={allSteps}
                        />,
                      ]
                    : []),
                ]}
              </StackedExpandables>
            )}
            {group.others.map((element, index) => (
              <div
                key={`other-${groupIndex}-${index}`}
                className={groupIndex === 0 && index === 0 ? animationClasses : ''}
              >
                {element}
              </div>
            ))}
          </div>
        )
      })}

      {/* Reasoning text display - rendered outside stacked expandables so it persists */}
      {currentReasoningPart && (
        <ReasoningDisplay
          text={currentReasoningPart.text}
          isStreaming={currentReasoningPart.state === 'streaming'}
          instanceKey={reasoningInstanceKey}
        />
      )}
    </div>
  )
})
