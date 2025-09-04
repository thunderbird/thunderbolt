import { splitPartType } from '@/lib/utils'
import type { UIMessage, ReasoningUIPart, TextUIPart, ToolUIPart } from 'ai'
import { ReasoningPart } from './reasoning-part'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'
import { ToolPart } from './tool-part'

interface AssistantMessageProps {
  message: UIMessage
  isStreaming: boolean // @todo legacy - can remove this
}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

const supportedPartTypes = ['reasoning', 'tool', 'text']

export const AssistantMessage = ({ message }: AssistantMessageProps) => {
  const filteredParts = message.parts.filter((part) => {
    const [partType] = splitPartType(part.type)
    if (!supportedPartTypes.includes(partType)) {
      return false
    }
    if (partType === 'text') {
      // Currently there is a bug in the Vercel AI SDK where empty text parts are emitted - we must remove them in order to avoid rendering empty gaps in the UI
      return (part as TextUIPart).text.trim() !== ''
    }
    return true
  })

  const partElements = []

  if (filteredParts.length === 0) {
    // isStreaming should always be true because the next part will *replace* this one
    partElements.push(<SyntheticLoadingPart isStreaming={true} />)
  }

  filteredParts.forEach((part) => {
    const [type] = splitPartType(part.type)

    switch (type) {
      case 'reasoning':
        partElements.push(<ReasoningPart part={part as ReasoningUIPart} />)
        break
      case 'tool':
        partElements.push(<ToolPart part={part as ToolUIPart} />)
        break
      case 'text':
        partElements.push(<TextPart part={part as TextUIPart} />)
        break
    }
  })

  return (
    <div>
      {partElements.map((partElement, index) => (
        // Skip the animation on the *second* (index === 1) partElement so that it replaces the loading part *in-place* without an animation
        // This causes it to appear as if the loading part magically *becomes* the new part without any visual disruption
        <div key={index} className={index === 1 ? '' : animationClasses}>
          {partElement}
        </div>
      ))}
    </div>
  )
}
