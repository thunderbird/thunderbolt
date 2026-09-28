/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createServer } from 'node:http'

type RpcRequest = {
  id?: string | number
  method: string
  params?: { name?: string; arguments?: { message?: string } }
}

/** Minimal Streamable HTTP MCP server for the browser-to-proxy tool round trip. */
export const createFakeMcpServer = (port: number) =>
  new Promise<ReturnType<typeof createServer>>((resolve) => {
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/mcp') {
        response.writeHead(405).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const rpc = JSON.parse(Buffer.concat(chunks).toString()) as RpcRequest
      if (rpc.id === undefined) {
        response.writeHead(202).end()
        return
      }

      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'test-mcp', version: '1.0.0' },
            }
          : rpc.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'echo',
                    description: 'Echo a message exactly. Use this for explicit echo requests.',
                    inputSchema: {
                      type: 'object',
                      properties: { message: { type: 'string' } },
                      required: ['message'],
                    },
                  },
                ],
              }
            : rpc.method === 'tools/call' && rpc.params?.name === 'echo'
              ? { content: [{ type: 'text', text: `MCP result: ${rpc.params.arguments?.message ?? ''}` }] }
              : null

      response.writeHead(result ? 200 : 404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(result ? { jsonrpc: '2.0', id: rpc.id, result } : { error: 'Unknown method' }))
    })
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
