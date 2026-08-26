/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { type ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { getMcpToolDisplay } from '@/lib/mcp-tool-display'
import type { I18n } from '@lingui/core'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { useFormatters } from '@/i18n/use-formatters'
import type { UIMessageMetadata } from '@/types'
import { getToolName } from 'ai'
import { AnimatePresence, m } from 'framer-motion'

type ReasoningGroupTitleProps = {
  totalDuration: number
  isGroupReasoning: boolean
  tools: ToolOrDynamicToolUIPart[]
  mcpTools?: UIMessageMetadata['mcpTools']
}

/**
 * Label shown for the in-progress tool. MCP `dynamic-tool` parts resolve to
 * `<server> · <tool>` (no curated loading verb); built-ins use their metadata
 * loading message.
 */
// `i18n` is injected rather than reached for: the descriptor has to resolve at
// render so the label follows a language change (see AGENTS.md).
const activeToolLabel = (
  i18n: I18n,
  tool: ToolOrDynamicToolUIPart,
  mcpTools?: UIMessageMetadata['mcpTools'],
): string => {
  const toolName = getToolName(tool)
  if (tool.type === 'dynamic-tool') {
    const { displayName, serverName } = getMcpToolDisplay(toolName, mcpTools, tool.title)
    return serverName ? `${serverName} · ${displayName}` : displayName
  }
  return i18n._(getToolMetadataSync(toolName, tool.input).loadingMessage)
}

export const ReasoningGroupTitle = ({ totalDuration, isGroupReasoning, tools, mcpTools }: ReasoningGroupTitleProps) => {
  const { i18n, t } = useLingui()
  const formatters = useFormatters()
  const duration = formatters.duration(totalDuration)
  const stepCount = tools.length
  const activeIndex = tools.length - 1
  const activeTool = tools[activeIndex]
  const loadingLabel = activeTool ? activeToolLabel(i18n, activeTool, mcpTools) : null

  return (
    <div className="relative">
      <AnimatePresence mode="wait">
        {isGroupReasoning ? (
          loadingLabel ? (
            <m.div
              key={`tool-${activeIndex}`}
              // Skip entrance animation for tools already in progress (e.g., when switching back to a chat with active streaming)
              initial={activeTool?.state === 'input-streaming' ? { y: 20, opacity: 0 } : { y: 0, opacity: 1 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: -20, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
              className="w-full"
            >
              <span
                data-testid="tool-status"
                className="text-xs text-muted-foreground italic animate-pulse truncate min-w-0"
              >
                {loadingLabel}
              </span>
            </m.div>
          ) : null
        ) : (
          <m.div
            key="completed"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="w-full"
          >
            {stepCount > 0
              ? plural(stepCount, {
                  one: `Completed # step in ${duration}`,
                  other: `Completed # steps in ${duration}`,
                })
              : t`Thought for ${duration}`}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}
