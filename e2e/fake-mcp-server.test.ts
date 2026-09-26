/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createFakeMcpServer } from './fake-mcp-server'

test('the fake MCP server lists and calls its echo tool', async () => {
  const server = await createFakeMcpServer(0)
  try {
    const address = server.address()
    if (!address || !('port' in address)) throw new Error('Fake MCP server has no TCP address')
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`))
    const client = new Client({ name: 'test-mcp-probe', version: '1.0.0' })
    await client.connect(transport)
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo'])
      expect(await client.callTool({ name: 'echo', arguments: { message: 'blue heron' } })).toMatchObject({
        content: [{ type: 'text', text: 'MCP result: blue heron' }],
      })
    } finally {
      await client.close()
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
