/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ReasoningGroupItem, type ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { getMcpToolDisplay } from '@/lib/mcp-tool-display'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { formatDuration } from '@/lib/utils'
import type { UIMessageMetadata } from '@/types'
import { getToolName, type ReasoningUIPart } from 'ai'
import { Brain, DotIcon, Loader2, type LucideIcon } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

type ReasoningItemProps = {
  part: ReasoningGroupItem
  onClick: () => void
  reasoningTime?: number
  isGroupReasoning: boolean
  mcpTools?: UIMessageMetadata['mcpTools']
}

type ItemIcon = LucideIcon | ComponentType<SVGProps<SVGSVGElement>>

type ItemData = {
  Icon: ItemIcon
  displayName: string
  /** Resolved MCP server name, rendered as a `<server> · <tool>` prefix when present. */
  serverName?: string
  isLoading: boolean
}

const isToolLoading = (part: ToolOrDynamicToolUIPart, isGroupReasoning: boolean): boolean =>
  isGroupReasoning && part.state !== 'output-available' && part.state !== 'output-error'

/**
 * MCP tools arrive as `dynamic-tool` parts and resolve their label/icon/server
 * from the message's `mcpTools` map; typed `tool-<name>` parts are built-ins
 * and keep their curated metadata icon.
 */
const getToolItemData = (
  toolPart: ToolOrDynamicToolUIPart,
  isGroupReasoning: boolean,
  mcpTools?: UIMessageMetadata['mcpTools'],
): ItemData => {
  const toolName = getToolName(toolPart)
  const isLoading = isToolLoading(toolPart, isGroupReasoning)

  if (toolPart.type === 'dynamic-tool') {
    const { displayName, icon, serverName } = getMcpToolDisplay(toolName, mcpTools, toolPart.title)
    return { Icon: icon.icon, displayName, serverName, isLoading }
  }

  const metadata = getToolMetadataSync(toolName)
  return { Icon: metadata.icon || DotIcon, displayName: metadata.displayName, isLoading }
}

const getItemData = (
  part: ReasoningGroupItem,
  isGroupReasoning: boolean,
  mcpTools?: UIMessageMetadata['mcpTools'],
): ItemData | null => {
  if (part.type === 'reasoning') {
    const reasoningPart = part.content as ReasoningUIPart
    return {
      Icon: Brain,
      displayName: 'Thinking',
      isLoading: isGroupReasoning && reasoningPart.state === 'streaming',
    }
  }

  if (part.type === 'tool') {
    return getToolItemData(part.content as ToolOrDynamicToolUIPart, isGroupReasoning, mcpTools)
  }

  return null
}

export const ReasoningItem = ({ part, onClick, reasoningTime, isGroupReasoning, mcpTools }: ReasoningItemProps) => {
  const itemData = getItemData(part, isGroupReasoning, mcpTools)

  if (!itemData) {
    return null
  }

  const { Icon, displayName, serverName, isLoading } = itemData

  return (
    <button
      onClick={onClick}
      className="flex items-center w-full py-2 px-3 hover:bg-accent/50 rounded-md transition-colors group text-left"
    >
      <div className="flex gap-3 flex-row flex-1 items-center min-w-0">
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground flex-shrink-0" />
        ) : (
          // color="currentColor" keeps simple-icons brand glyphs monochrome (their default), matching lucide.
          <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" color="currentColor" />
        )}
        <span className="text-sm font-medium truncate text-foreground">
          {serverName ? (
            <>
              <span className="text-muted-foreground">{serverName}</span> · {displayName}
            </>
          ) : (
            displayName
          )}
        </span>
      </div>
      <span className="text-xs text-muted-foreground flex-shrink-0">
        {reasoningTime ? formatDuration(reasoningTime) : isLoading ? '...' : '-'}
      </span>
    </button>
  )
}
