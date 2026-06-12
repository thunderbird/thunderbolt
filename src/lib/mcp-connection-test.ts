/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMCPClient } from '@ai-sdk/mcp'

/** The `@ai-sdk/mcp` client factory. Injectable so unit tests avoid a real network round-trip. */
type CreateMcpClient = typeof createMCPClient

/** The transport object the `@ai-sdk/mcp` client factory accepts. */
export type McpTransport = Parameters<CreateMcpClient>[0]['transport']

/**
 * Connects an MCP client over `transport`, lists the server's tool names, then
 * always closes the client — even when listing throws — so a failed probe never
 * leaks the connection. Returns the tool names (empty when the server exposes none).
 *
 * Extracted as a standalone, testable function (mirrors `src/acp/connection-test.ts`)
 * so the settings page can stay focused on display state. `createClient` is
 * injectable for unit tests.
 */
export const probeMcpServerTools = async (
  transport: McpTransport,
  createClient: CreateMcpClient = createMCPClient,
): Promise<string[]> => {
  const mcpClient = await createClient({ transport })

  try {
    return Object.keys(await mcpClient.tools())
  } finally {
    await mcpClient.close()
  }
}
