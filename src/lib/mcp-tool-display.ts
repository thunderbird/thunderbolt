/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fallbackMcpIcon, getMcpIcon, type McpIcon } from './mcp-icons'
import { formatDisplayName } from './tool-metadata'

/**
 * Structural description of an MCP server, keyed in the metadata map by the
 * sanitized tool prefix it was assigned (e.g. `render`, `render_2`). Declared
 * structurally so this module stays independent of the metadata type in
 * `types.ts`.
 */
type McpServerInfo = { id: string; name: string; url: string }

/** Map of sanitized prefix → server info, carried on message metadata. */
type McpServerMap = Record<string, McpServerInfo>

/**
 * Display fields for an MCP tool call row. `serverName` is undefined when no
 * server could be resolved (old messages without the metadata map), in which
 * case the caller renders the prettified full tool name with the generic icon
 * and no server badge.
 */
export type McpToolDisplay = {
  displayName: string
  icon: McpIcon
  serverName?: string
}

/**
 * Finds the server whose prefix is the longest match for `toolName`, i.e. the
 * longest map key `k` such that `toolName` starts with `k + '_'`. Longest wins
 * so `render_2_list_services` resolves to the `render_2` server rather than
 * `render`. Returns the matched key alongside its server info, or null.
 */
const resolveServer = (
  toolName: string,
  mcpServers: McpServerMap,
): { prefix: string; server: McpServerInfo } | null => {
  let match: { prefix: string; server: McpServerInfo } | null = null
  for (const [prefix, server] of Object.entries(mcpServers)) {
    if (!toolName.startsWith(`${prefix}_`)) {
      continue
    }
    if (!match || prefix.length > match.prefix.length) {
      match = { prefix, server }
    }
  }
  return match
}

/**
 * Resolves an MCP tool call's display fields from its namespaced tool name and
 * the message's `mcpServers` map. When a server is resolved, the de-prefixed
 * tool name is prettified for `displayName`, the server's URL picks the brand
 * icon, and `serverName` is returned so the caller can compose the
 * `"<serverName> · <displayName>"` row label. An explicit MCP tool `title`
 * (when the SDK provides one) takes precedence over the derived name.
 *
 * Falls back gracefully for old messages or unknown prefixes: the full tool
 * name is prettified and the generic `Blocks` icon is used with no server.
 */
export const getMcpToolDisplay = (toolName: string, mcpServers?: McpServerMap, title?: string): McpToolDisplay => {
  const match = mcpServers ? resolveServer(toolName, mcpServers) : null

  if (!match) {
    return { displayName: title || formatDisplayName(toolName), icon: fallbackMcpIcon }
  }

  const bareName = toolName.slice(match.prefix.length + 1)
  return {
    displayName: title || formatDisplayName(bareName),
    icon: getMcpIcon(match.server.url),
    serverName: match.server.name,
  }
}
