import type { ReasoningUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai'
import { splitPartType } from './utils'

/**
 * Union type of AI message parts that can be processed and potentially grouped.
 * Used as input to `groupToolParts` after filtering with `filterMessageParts`.
 */
export type GroupableUIPart = ReasoningUIPart | TextUIPart | ToolUIPart

/**
 * A synthetic UI part type that represents multiple consecutive tool calls grouped together.
 * Created by `groupToolParts` to render multiple related tool calls in a single `ToolGroup` component
 * for better UX (showing tool calls as a batch rather than scattered individually).
 */
export type ToolGroupUIPart = {
  type: 'group_tools'
  tools: ToolUIPart[]
}

/**
 * Union type representing all possible parts after grouping transformation.
 * Either an original part (reasoning, text, or individual tool) or a synthetic `ToolGroupUIPart`.
 * Used as output from `groupToolParts` and input to `mountMessageParts` for rendering.
 */
export type GroupedUIPart = GroupableUIPart | ToolGroupUIPart

const supportedPartTypes = ['reasoning', 'tool', 'text']

/**
 * Groups consecutive tool calls into `ToolGroupUIPart` nodes for batch rendering.
 *
 * **Context**: Called by `AssistantMessage` component after filtering to organize tool calls for display.
 * Tool calls (like `read_file`, `grep`, etc.) are grouped together to show as a compact tool panel
 * rather than scattered individually throughout the message.
 *
 * **Grouping logic**:
 * - Consecutive tool calls → grouped into single `ToolGroupUIPart`
 * - Text/reasoning parts → kept as-is and break any active tool group
 *
 * **Example transformation**:
 * ```
 * [tool-read_file, tool-grep, text, tool-search] →
 * [ToolGroupUIPart([read_file, grep]), text, ToolGroupUIPart([search])]
 * ```
 *
 * @param parts - Filtered message parts (output from `filterMessageParts`)
 * @returns Parts with consecutive tools grouped into `ToolGroupUIPart` nodes
 */
export const groupToolParts = (parts: GroupableUIPart[]): GroupedUIPart[] => {
  const grouped: GroupedUIPart[] = []
  let currentGroup: ToolUIPart[] = []

  // Collects the currently buffered tool parts into a single group node so they render via ToolGroup.
  const flushGroup = () => {
    if (currentGroup.length === 0) {
      return
    }

    grouped.push({
      type: 'group_tools',
      tools: [...currentGroup],
    })

    currentGroup = []
  }

  // Walk through the incoming parts and buffer every consecutive tool call.
  parts.forEach((part) => {
    const [partType] = splitPartType(part.type)

    if (partType === 'tool') {
      currentGroup.push(part as ToolUIPart)
      return
    }

    // Non-tool parts break the current streak, so flush first then append the part itself.
    flushGroup()
    grouped.push(part)
  })

  // Ensure any trailing tool streak is output after iteration.
  flushGroup()

  return grouped
}

/**
 * Filters AI streaming message parts to remove unsupported types and empty content.
 *
 * **Context**: Called first by `AssistantMessage` component when rendering AI responses.
 * The AI streaming library (Vercel AI SDK) may emit various part types, but only a subset
 * are supported by our UI. This function acts as a sanitizer before grouping and rendering.
 *
 * **Filtering rules**:
 * - Keeps only `reasoning`, `tool`, and `text` part types
 * - Removes text parts that are empty or whitespace-only
 * - Removes any unsupported part types (e.g., `source-url`, experimental types)
 *
 * **Used in**: `AssistantMessage` component, which pipes the filtered output to `groupToolParts`
 * before rendering with `mountMessageParts`.
 *
 * @param parts - Raw message parts from AI streaming response (may include unsupported types)
 * @returns Cleaned array containing only supported, non-empty parts ready for grouping
 */
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
