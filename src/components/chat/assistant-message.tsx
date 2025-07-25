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

  // Combine multiple reasoning parts into one for display
  const reasoningParts = filteredParts.filter(part => part.type === 'reasoning')
  const nonReasoningParts = filteredParts.filter(part => part.type !== 'reasoning')
  
  const combinedReasoningText = reasoningParts.map(part => (part as any).text).join('')
  const combinedReasoningPart = combinedReasoningText ? {
    type: 'reasoning' as const,
    text: combinedReasoningText
  } : null

  // Rebuild the parts list with combined reasoning
  const processedParts = []
  if (combinedReasoningPart) {
    processedParts.push(combinedReasoningPart)
  }
  processedParts.push(...nonReasoningParts)

  const partElements = []

  if (processedParts.length === 0) {
    partElements.push(<SyntheticLoadingPart isStreaming={true} />)
  }

  processedParts.forEach((part, index) => {
    const isLastPart = index === processedParts.length - 1
    const isPartStreaming = isStreaming && isLastPart

    switch (part.type) {
      case 'reasoning':
        // For reasoning, check if we're still receiving reasoning parts in the original message
        const isReasoningStreaming = isStreaming && reasoningParts.length > 0
        partElements.push(<ReasoningPart part={part} isStreaming={isReasoningStreaming} />)
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
