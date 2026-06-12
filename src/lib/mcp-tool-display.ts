/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fallbackMcpIcon, getMcpIcon, type McpIcon } from './mcp-icons'
import { formatDisplayName } from './tool-metadata'

/**
 * Per-invoked-tool entry carried on message metadata, keyed by the exact
 * namespaced tool name. `name`/`url` identify the owning server; `toolName` is
 * the bare (de-namespaced) tool name used for the display label. Declared
 * structurally so this module stays independent of the metadata type in
 * `types.ts`.
 */
type McpToolInfo = { name: string; url: string; toolName: string }

/** Map of namespaced tool name → owning-server info, carried on message metadata. */
type McpToolMap = Record<string, McpToolInfo>

/**
 * Display fields for an MCP tool call row. `serverName` is undefined when the
 * tool could not be resolved (old messages without the metadata map), in which
 * case the caller renders the prettified full tool name with the generic icon
 * and no server badge.
 */
export type McpToolDisplay = {
  displayName: string
  icon: McpIcon
  serverName?: string
}

/**
 * Resolves an MCP tool call's display fields from its namespaced tool name and
 * the message's `mcpTools` map. The lookup is exact (`mcpTools[toolName]`) — no
 * prefix heuristics — so attribution is never ambiguous. When the tool resolves,
 * the bare tool name is prettified for `displayName`, the server's URL picks the
 * brand icon, and `serverName` is returned so the caller can compose the
 * `"<serverName> · <displayName>"` row label. An explicit MCP tool `title`
 * (when the SDK provides one) takes precedence over the derived name.
 *
 * Falls back gracefully when the tool isn't in the map (old messages, including
 * preview-env ones persisted with the earlier prefix-keyed shape, or unknown
 * tools): the full tool name is prettified and the generic `Blocks` icon is used
 * with no server.
 */
export const getMcpToolDisplay = (toolName: string, mcpTools?: McpToolMap, title?: string): McpToolDisplay => {
  const tool = mcpTools?.[toolName]

  if (!tool) {
    return { displayName: title || formatDisplayName(toolName), icon: fallbackMcpIcon }
  }

  return {
    displayName: title || formatDisplayName(tool.toolName),
    icon: getMcpIcon(tool.url),
    serverName: tool.name,
  }
}
