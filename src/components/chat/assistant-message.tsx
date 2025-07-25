import { UIMessage } from 'ai'
import { ReasoningPart } from './reasoning-part'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'
import { ToolInvocationPart } from './tool-invocation-part'

interface AssistantMessageProps {
  message: UIMessage
  isStreaming: boolean
}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

const supportedPartTypes = ['reasoning', 'tool-invocation', 'text']

export const AssistantMessage = ({ message, isStreaming }: AssistantMessageProps) => {
  const filteredParts = message.parts.filter((part) => supportedPartTypes.includes(part.type))

  const partElements = []

  if (filteredParts.length === 0) {
    partElements.push(<SyntheticLoadingPart isStreaming={true} />)
  }

  filteredParts.forEach((part, index) => {
    const isLastPart = index === filteredParts.length - 1
    const isPartStreaming = isStreaming && isLastPart

    switch (part.type) {
      case 'reasoning':
        partElements.push(<ReasoningPart part={part} isStreaming={isPartStreaming} />)
        break
      case 'tool-invocation':
        partElements.push(<ToolInvocationPart part={part} isStreaming={isPartStreaming} />)
        break
      case 'text':
        partElements.push(<TextPart part={part} isStreaming={isPartStreaming} />)
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