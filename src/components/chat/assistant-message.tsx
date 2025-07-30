import { UIMessage } from 'ai'
import { useState } from 'react'
import { ReasoningPart } from './reasoning-part'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'
import { ToolInvocationPart } from './tool-invocation-part'
import { ToolsSummaryPart } from './tools-summary-part'
import { StackedExpandables } from '../ui/stacked-expandables'

interface AssistantMessageProps {
  message: UIMessage
  isStreaming: boolean
}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

const supportedPartTypes = ['reasoning', 'tool-invocation', 'text']

export const AssistantMessage = ({ message, isStreaming }: AssistantMessageProps) => {
  const filteredParts = message.parts.filter((part) => supportedPartTypes.includes(part.type))
  const [toolsStartTime] = useState(() => Date.now())

  const partGroups: { expandables: React.ReactElement[]; others: React.ReactElement[]; hasTools: boolean }[] = []
  let currentGroup: { expandables: React.ReactElement[]; others: React.ReactElement[]; hasTools: boolean } = { expandables: [], others: [], hasTools: false }

  if (filteredParts.length === 0) {
    currentGroup.others.push(<SyntheticLoadingPart isStreaming={true} />)
  }

  // Track tool indices for each group
  const toolIndicesByGroup: number[][] = []
  let currentToolIndices: number[] = []

  filteredParts.forEach((part, index) => {
    const isLastPart = index === filteredParts.length - 1
    const isPartStreaming = isStreaming && isLastPart

    switch (part.type) {
      case 'reasoning':
      case 'tool-invocation': {
        const element = part.type === 'reasoning' 
          ? <ReasoningPart key={`${part.type}-${index}`} part={part} isStreaming={isPartStreaming} />
          : <ToolInvocationPart key={`${part.type}-${index}`} part={part} isStreaming={isPartStreaming} />
        
        currentGroup.expandables.push(element)
        
        if (part.type === 'tool-invocation') {
          currentGroup.hasTools = true
          currentToolIndices.push(index)
        }
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
        currentGroup.others.push(<TextPart key={`${part.type}-${index}`} part={part} isStreaming={isPartStreaming} />)
        break
      }
    }
  })

  // Add the last group if it has content
  if (currentGroup.expandables.length > 0 || currentGroup.others.length > 0) {
    partGroups.push(currentGroup)
    toolIndicesByGroup.push(currentToolIndices)
  }

  // Check if all tools in all groups are completed
  const allToolsCompleted = filteredParts.every((part) => {
    if (part.type === 'tool-invocation') {
      const toolInvocation = (part as any).toolInvocation
      return 'result' in toolInvocation || 'error' in toolInvocation
    }
    return true
  })

  // Count total tools
  const totalToolCount = filteredParts.filter(part => part.type === 'tool-invocation').length
  
  // Find the last tool index
  let lastToolIndex = -1
  filteredParts.forEach((part, index) => {
    if (part.type === 'tool-invocation') {
      lastToolIndex = index
    }
  })
  
  // Check if we've streamed past all tools
  const currentStreamingIndex = filteredParts.length - 1
  const pastAllTools = lastToolIndex === -1 || currentStreamingIndex > lastToolIndex

  return (
    <div>
      {partGroups.map((group, groupIndex) => {
        // Check if this is the last group with tools
        const isLastToolGroup = group.hasTools && 
          partGroups.slice(groupIndex + 1).every(g => !g.hasTools)
        
        // Show summary if:
        // 1. This is the last group with tools
        // 2. All tools are completed (have results)
        // 3. We've streamed past all tool invocations
        const shouldShowSummary = isLastToolGroup && allToolsCompleted && totalToolCount > 0 && pastAllTools
        
        return (
          <div key={groupIndex}>
            {group.expandables.length > 0 && (
              <StackedExpandables className={groupIndex === 0 ? animationClasses : ''}>
                {[
                  ...group.expandables,
                  // Add tools summary only to the last group with tools, when all tools are done
                  ...(shouldShowSummary
                    ? [<ToolsSummaryPart 
                        key="tools-summary"
                        toolCount={totalToolCount}
                        duration={Date.now() - toolsStartTime}
                      />]
                    : [])
                ]}
              </StackedExpandables>
            )}
            {group.others.map((element, index) => (
              <div key={`other-${groupIndex}-${index}`} className={groupIndex === 0 && index === 0 ? animationClasses : ''}>
                {element}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
