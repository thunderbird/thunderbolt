/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { McpServer } from '@/types'

/**
 * Strips the protocol and trailing slash from an MCP server URL for display
 * (`https://api.example.com/mcp/` → `api.example.com/mcp`). An iroh NodeId or
 * other non-URL target is returned as-is.
 */
export const cleanServerUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname.replace(/\/$/, '')}`
  } catch {
    return url.replace(/^https?:\/\//, '')
  }
}

/** Display title for an MCP server row/panel: its name, falling back to the cleaned URL. */
export const serverDisplayName = (server: McpServer): string => server.name || cleanServerUrl(server.url ?? '')

/** Case-insensitive match against a server's name and URL for the page search.
 *  Accepts nullable fields structurally — rows synced from other devices can
 *  have a null name. */
export const serverMatchesQuery = (server: { name?: string | null; url?: string | null }, query: string): boolean => {
  if (!query) {
    return true
  }
  const needle = query.toLowerCase()
  return (server.name ?? '').toLowerCase().includes(needle) || (server.url ?? '').toLowerCase().includes(needle)
}
