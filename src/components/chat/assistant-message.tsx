import { UIMessage } from 'ai'
import { ReasoningPart } from './reasoning-part'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'
import { ToolInvocationPart } from './tool-invocation-part'
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

  const partGroups: { expandables: React.ReactElement[]; others: React.ReactElement[] }[] = []
  let currentGroup: { expandables: React.ReactElement[]; others: React.ReactElement[] } = { expandables: [], others: [] }

  if (filteredParts.length === 0) {
    currentGroup.others.push(<SyntheticLoadingPart isStreaming={true} />)
  }

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
        break
      }
      case 'text': {
        // If we have expandables, save current group and start a new one
        if (currentGroup.expandables.length > 0) {
          partGroups.push(currentGroup)
          currentGroup = { expandables: [], others: [] }
        }
        currentGroup.others.push(<TextPart key={`${part.type}-${index}`} part={part} isStreaming={isPartStreaming} />)
        break
      }
    }
  })

  // Add the last group if it has content
  if (currentGroup.expandables.length > 0 || currentGroup.others.length > 0) {
    partGroups.push(currentGroup)
  }

  return (
    <div>
      {partGroups.map((group, groupIndex) => (
        <div key={groupIndex}>
          {group.expandables.length > 0 && (
            <StackedExpandables className={groupIndex === 0 ? animationClasses : ''}>
              {group.expandables}
            </StackedExpandables>
          )}
          {group.others.map((element, index) => (
            <div key={`other-${groupIndex}-${index}`} className={groupIndex === 0 && index === 0 ? animationClasses : ''}>
              {element}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
