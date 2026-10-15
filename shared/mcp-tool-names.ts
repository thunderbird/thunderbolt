/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Sanitizes an MCP server name into the prefix its tools are namespaced under, so two servers that both expose
 * `search` stay distinct and the model knows which server owns each tool. Lowercases and turns every run of
 * non-alphanumeric characters into one underscore. A null or empty name (the app's `mcp_servers.name` is a
 * nullable synced column) falls back to `mcp` rather than crashing the send.
 */
export const sanitizeToolPrefix = (serverName: string | null | undefined): string =>
  (serverName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'mcp'
