import { parseContentParts } from '@/ai/visual-parser'
import { filterMessageParts, type GroupableUIPart, groupToolParts, type ToolGroupUIPart } from '@/lib/assistant-message'
import { splitPartType } from '@/lib/utils'
import type { ThunderboltUIMessage } from '@/types'
import type { ReasoningUIPart, TextUIPart, ToolUIPart } from 'ai'
import { memo, type ReactNode, useMemo } from 'react'
import { ReasoningPart } from './reasoning-part'
import { StreamingMarkdown } from './streaming-markdown'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { ToolGroup } from './tool-group'
import { ToolPart } from './tool-part'
import { VisualRenderer } from './visual-renderer'

interface AssistantMessageProps {
  message: ThunderboltUIMessage
  isStreaming: boolean
}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

/**
 * Mounts message parts into React elements
 */
export const mountMessageParts = (
  groupedParts: (ReasoningUIPart | TextUIPart | ToolUIPart | ToolGroupUIPart)[],
  isStreaming: boolean,
): ReactNode[] => {
  const elements: ReactNode[] = []

  groupedParts.forEach((part, partIndex) => {
    const [partType] = splitPartType(part.type)

    switch (partType) {
      case 'reasoning':
        elements.push(<ReasoningPart key={`reasoning-${partIndex}`} part={part as ReasoningUIPart} />)
        break
      case 'group_tools': {
        const toolGroup = part as ToolGroupUIPart
        const hasTextPart = groupedParts.some((p) => splitPartType(p.type)[0] === 'text')
        const isLastPart = partIndex === groupedParts.length - 1
        elements.push(
          <ToolGroup
            key={`tools-${partIndex}`}
            tools={toolGroup.tools}
            isStreaming={isStreaming}
            isLastPartInMessage={isLastPart}
            hasTextInMessage={hasTextPart}
          />,
        )
        break
      }
      case 'tool':
        elements.push(<ToolPart key={`tool-${partIndex}`} part={part as ToolUIPart} />)
        break
      case 'text': {
        const textPart = part as TextUIPart
        if (textPart.text) {
          // Parse the text into content parts (text + visuals in order)
          const contentParts = parseContentParts(textPart.text)

          contentParts.forEach((contentPart, contentIndex) => {
            if (contentPart.type === 'text') {
              elements.push(
                <div key={`text-${partIndex}-${contentIndex}`} className="p-4 rounded-md mr-auto w-full my-2">
                  <StreamingMarkdown
                    content={contentPart.content}
                    isStreaming={textPart.state === 'streaming'}
                    className="text-secondary-foreground leading-relaxed"
                  />
                </div>,
              )
            } else {
              elements.push(
                <div key={`visual-${partIndex}-${contentIndex}`} className={animationClasses}>
                  <VisualRenderer visual={contentPart.visual} />
                </div>,
              )
            }
          })
        }
        break
      }
    }
  })

  // Show loading indicator if no parts yet
  if (elements.length === 0) {
    elements.push(<SyntheticLoadingPart key="loading" isStreaming={true} />)
  }

  return elements
}

export const AssistantMessage = memo(({ message, isStreaming }: AssistantMessageProps) => {
  const filteredParts = filterMessageParts(message.parts) as GroupableUIPart[]

  const groupedParts = groupToolParts(filteredParts)

  // Build elements preserving the order of text and visuals
  const allElements = useMemo(() => mountMessageParts(groupedParts, isStreaming), [groupedParts, isStreaming])

  return (
    <div>
      {allElements.map((element, index) => (
        // Skip the animation on the *second* (index === 1) element so that it replaces the loading part *in-place* without an animation
        // This causes it to appear as if the loading part magically *becomes* the new part without any visual disruption
        <div key={index} className={index === 1 ? '' : animationClasses}>
          {element}
        </div>
      ))}
    </div>
  )
})
