import type { ReasoningUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai'
import { splitPartType } from './utils'

export type GroupableUIPart = ReasoningUIPart | TextUIPart | ToolUIPart

export type ToolGroupUIPart = {
  type: 'group_tools'
  tools: ToolUIPart[]
  parts: (ToolUIPart | ReasoningUIPart)[]
}

export type GroupedUIPart = GroupableUIPart | ToolGroupUIPart

const supportedPartTypes = ['reasoning', 'tool', 'text']

export const groupToolParts = (parts: GroupableUIPart[]): GroupedUIPart[] => {
  const grouped: GroupedUIPart[] = []
  let currentGroup: (ToolUIPart | ReasoningUIPart)[] = []

  // Collects the currently buffered tool parts and reasoning into a single group node so they render via ToolGroup.
  const flushGroup = () => {
    if (currentGroup.length === 0) {
      return
    }

    // Extract only tools for the tools array (for backward compatibility)
    const tools: ToolUIPart[] = currentGroup.filter((part) => part.type !== 'reasoning') as ToolUIPart[]

    grouped.push({
      type: 'group_tools',
      tools,
      parts: [...currentGroup], // Keep original order for rendering
    })

    currentGroup = []
  }

  // Walk through the incoming parts and buffer every consecutive non-display tool call and reasoning.
  parts.forEach((part) => {
    const [partType, toolName] = splitPartType(part.type)

    if ((partType === 'tool' && !toolName.startsWith('display-')) || partType === 'reasoning') {
      currentGroup.push(part as ToolUIPart | ReasoningUIPart)
      return
    }

    // Non-bufferable parts break the current streak, so flush first then append the part itself.
    flushGroup()
    grouped.push(part)
  })

  // Ensure any trailing tool streak is output after iteration.
  flushGroup()

  return grouped
}

export const filterMessageParts = (parts: UIMessage['parts']) =>
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
