import { UIMessage, type ReasoningUIPart, type TextUIPart, type ToolUIPart } from 'ai'
import { ReasoningPart } from './reasoning-part'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'
import { ToolInvocationPart } from './tool-part'

interface AssistantMessageProps {
  message: UIMessage
  isStreaming: boolean
}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

const supportedPartTypes = ['reasoning', 'tool', 'text']

export const AssistantMessage = ({ message, isStreaming }: AssistantMessageProps) => {
  const filteredParts = message.parts.filter((part) => {
    const type = part.type.split('-')[0]
    return supportedPartTypes.includes(type)
  })

  const partElements = []

  if (filteredParts.length === 0) {
    partElements.push(<SyntheticLoadingPart isStreaming={true} />)
  }

  filteredParts.forEach((part, index) => {
    const type = part.type.split('-')[0]
    const isLastPart = index === filteredParts.length - 1
    const isPartStreaming = isStreaming && isLastPart

    switch (type) {
      case 'reasoning':
        partElements.push(<ReasoningPart part={part as ReasoningUIPart} isStreaming={isPartStreaming} />)
        break
      case 'tool':
        partElements.push(<ToolInvocationPart part={part as ToolUIPart} isStreaming={isPartStreaming} />)
        break
      case 'text':
        partElements.push(<TextPart part={part as TextUIPart} isStreaming={isPartStreaming} />)
        break
    }
  })

  return (
    <div>
      {partElements.map((part, index) => (
        <div key={index} className={index === 1 ? '' : animationClasses}>
          {part}
        </div>
      ))}
    </div>
  )
}
