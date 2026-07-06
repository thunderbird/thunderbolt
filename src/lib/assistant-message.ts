/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isRenderHtmlPart, renderHtmlOutput } from '@/artifacts/render-html-tool'
import {
  type DynamicToolUIPart,
  isToolOrDynamicToolUIPart,
  type ReasoningUIPart,
  type TextUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai'

/**
 * A tool-like UI part. MCP tools use the AI SDK's automatic schemas, so the SDK
 * emits them as `dynamic-tool` parts rather than typed `tool-<name>` parts; both
 * shapes are treated uniformly via `isToolOrDynamicToolUIPart` / `getToolName`.
 */
export type ToolOrDynamicToolUIPart = ToolUIPart | DynamicToolUIPart

/**
 * Union type of AI message parts that can be processed and potentially grouped.
 * Used as input to `groupToolParts` after filtering with `filterMessageParts`.
 */
export type GroupableUIPart = ReasoningUIPart | TextUIPart | ToolOrDynamicToolUIPart

/**
 * A synthetic UI part type that represents multiple consecutive reasoning/tool parts grouped together.
 * Created by `groupMessageParts` to render related reasoning + tool calls in a single group
 * for better UX (showing them as a batch rather than scattered individually).
 */
export type ReasoningGroupItem<T = unknown> = { type: 'tool' | 'reasoning'; content: T; id: string }

export type ReasoningGroupUIPart = {
  type: 'reasoning_group'
  items: ReasoningGroupItem[]
}

/**
 * Union type representing all possible parts after grouping transformation.
 * Either an original part (reasoning, text, or individual tool) or a synthetic `ReasoningGroupUIPart`.
 * Used as output from `groupMessageParts` and input to `mountMessageParts` for rendering.
 */
export type GroupedUIPart = GroupableUIPart | ReasoningGroupUIPart

/**
 * Whether a render_html part should render as its own artifact card rather than a
 * generic tool card. It lifts out as soon as the call starts (so the card shows
 * immediately and streams into place) and while verifying; only a finished call
 * that failed — or errored — stays an ordinary tool call in the group.
 */
export const artifactRendersStandalone = (part: ToolOrDynamicToolUIPart): boolean => {
  if (part.state === 'output-error') {
    return false
  }
  if (part.state === 'output-available') {
    return renderHtmlOutput(part)?.ok === true
  }
  return true
}

/**
 * Groups consecutive reasoning/tool parts into `reasoning_group` nodes for batch rendering.
 *
 * **Context**: Called by `AssistantMessage` after filtering, to organize tool calls for display.
 * Reasoning and tool calls (like `read_file`, `grep`, etc.) are grouped into a compact panel rather
 * than scattered through the message. A streaming or verified `render_html` part is lifted out to
 * render as its own artifact instead of joining the group.
 *
 * **Grouping logic**:
 * - Consecutive reasoning/tool parts → grouped into a single `ReasoningGroupUIPart`
 * - Text parts → kept as-is and break any active group
 *
 * @param parts - Filtered message parts (output from `filterMessageParts`)
 * @returns Parts with consecutive reasoning/tool parts grouped into `ReasoningGroupUIPart` nodes
 */
export const groupMessageParts = (parts: GroupableUIPart[]): GroupedUIPart[] => {
  const grouped: GroupedUIPart[] = []
  let currentItems: ReasoningGroupItem[] = []

  // Collects the currently buffered items into a single group node so they render via a group component.
  const flushGroup = () => {
    if (currentItems.length === 0) {
      return
    }

    grouped.push({
      type: 'reasoning_group',
      items: [...currentItems],
    })

    currentItems = []
  }

  // This is used to generate a unique id for each reasoning part
  // with this id we can get the reasoning time for each part we have saved message metadata
  let reasoningIdCounter = 0

  // Walk through the incoming parts and buffer every consecutive tool call.
  // Both typed `tool-<name>` parts and MCP `dynamic-tool` parts group as tool items.
  parts.forEach((part) => {
    if (isToolOrDynamicToolUIPart(part)) {
      // An artifact renders on its own from the moment the call starts — a live scripts-off
      // preview streams into place (even before any HTML has arrived), then it becomes the
      // verified result. Only a finished call that FAILED verification — or errored — stays in
      // the group as an ordinary tool call.
      if (isRenderHtmlPart(part) && artifactRendersStandalone(part)) {
        flushGroup()
        grouped.push(part)
        return
      }

      currentItems.push({ type: 'tool', content: part, id: part.toolCallId })
      return
    }

    if (part.type === 'reasoning') {
      currentItems.push({ type: 'reasoning', content: part, id: `reasoning-${reasoningIdCounter}` })
      reasoningIdCounter++
      return
    }

    // Non-groupable parts break the current streak, so flush first then append the part itself.
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
 * - Keeps `reasoning`, `text`, and any tool-like part (typed `tool-<name>` and MCP `dynamic-tool`)
 * - Removes text parts that are empty or whitespace-only
 * - Removes any unsupported part types (e.g., `source-url`, experimental types)
 *
 * **Used in**: `AssistantMessage` component, which pipes the filtered output to `groupToolParts`
 * before rendering with `mountMessageParts`.
 *
 * @param parts - Raw message parts from AI streaming response (may include unsupported types)
 * @returns Cleaned array containing only supported, non-empty parts ready for grouping
 */
export const filterMessageParts = (parts: UIMessage['parts']): GroupableUIPart[] =>
  parts.filter((part): part is GroupableUIPart => {
    if (part.type === 'text') {
      return part.text.trim() !== ''
    }
    return part.type === 'reasoning' || isToolOrDynamicToolUIPart(part)
  })
