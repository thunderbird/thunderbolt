import { splitPartType } from '@/lib/utils'
import type { UIMessage, ReasoningUIPart, TextUIPart, ToolUIPart } from 'ai'
import { memo, type ReactNode } from 'react'
import { DisplayToolHandler } from './display-tool-handler'
import { ReasoningPart } from './reasoning-part'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'
import { ToolGroup } from './tool-group'

type GroupableUIPart = ReasoningUIPart | TextUIPart | ToolUIPart

type ToolGroupUIPart = {
  type: 'group_tools'
  tools: ToolUIPart[]
}

type GroupedUIPart = GroupableUIPart | ToolGroupUIPart

interface AssistantMessageProps {
  message: UIMessage
  isStreaming: boolean // @todo legacy - can remove this
}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

const supportedPartTypes = ['reasoning', 'tool', 'text']

const groupToolParts = (parts: GroupableUIPart[]): GroupedUIPart[] => {
  const grouped: GroupedUIPart[] = []
  let currentGroup: ToolUIPart[] = []

  const flushGroup = () => {
    if (currentGroup.length === 0) {
      return
    }

    if (currentGroup.length === 1) {
      grouped.push(currentGroup[0])
    } else {
      grouped.push({
        type: 'group_tools',
        tools: [...currentGroup],
      })
    }

    currentGroup = []
  }

  parts.forEach((part) => {
    const [partType, toolName] = splitPartType(part.type)

    if (partType === 'tool' && !toolName.startsWith('display-')) {
      currentGroup.push(part as ToolUIPart)
      return
    }

    flushGroup()
    grouped.push(part)
  })

  flushGroup()

  return grouped
}

const filterMessageParts = (parts: UIMessage['parts']) =>
  parts.filter((part) => {
    const [partType] = splitPartType(part.type)

    if (!supportedPartTypes.includes(partType)) {
      return false
    }

    if (partType === 'text') {
      return (part as TextUIPart).text.trim() !== ''
    }

    return true
  })

const mountMessageParts = (groupedParts: GroupedUIPart[]) => {
  const partElements: ReactNode[] = []

  if (groupedParts.length === 0) {
    // isStreaming should always be true because the next part will *replace* this one
    partElements.push(<SyntheticLoadingPart isStreaming={true} />)
  }

  groupedParts.forEach((part) => {
    const [partType] = splitPartType(part.type)

    switch (partType) {
      case 'reasoning':
        partElements.push(<ReasoningPart part={part as ReasoningUIPart} />)
        break
      case 'group_tools':
        partElements.push(<ToolGroup tools={(part as ToolGroupUIPart).tools} />)
        break
      case 'tool':
        partElements.push(<DisplayToolHandler part={part as ToolUIPart} />)
        break
      case 'text':
        partElements.push(<TextPart part={part as TextUIPart} />)
        break
    }
  })

  return partElements
}

export const AssistantMessage = memo(({ message }: AssistantMessageProps) => {
  const filteredParts = filterMessageParts(message.parts) as GroupableUIPart[]

  const groupedParts = groupToolParts(filteredParts)

  const partElements: ReactNode[] = mountMessageParts(groupedParts)

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
})
