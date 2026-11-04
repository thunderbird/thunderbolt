/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createMCPClient } from '@ai-sdk/mcp'
import { z } from 'zod'
import { CloudError } from './errors'
import { createMcpDispatchFetch, executeMcpToolCall } from './mcp-dispatch'

const request = (method: string) => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: '1', method }) })
const transport = (send: () => Promise<Response>) =>
  createMcpDispatchFetch(Object.assign(send, { preconnect: () => {} }))

describe('MCP side-effect dispatch boundary', () => {
  it('tracks the real SDK request path, disables tool retry, and preserves a later known error result', async () => {
    const calls: string[] = []
    const state = { disconnect: true }
    const upstream = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init)
      if (request.method !== 'POST') {
        return new Response(null, { status: 405 })
      }
      const message = z
        .object({ method: z.string(), id: z.union([z.string(), z.number()]).optional() })
        .parse(await request.json())
      if (message.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (message.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          },
        })
      }
      calls.push(message.method)
      if (state.disconnect) {
        throw new Error('Socket disconnected after dispatch')
      }
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: 'Known failure' }] },
      })
    }
    const client = await createMCPClient({
      maxRetries: 0,
      transport: {
        type: 'http',
        url: 'https://tools.example.test',
        fetch: createMcpDispatchFetch(Object.assign(upstream, { preconnect: () => {} })),
      },
    })
    try {
      const tools = client.toolsFromDefinitions({
        tools: [{ name: 'write', inputSchema: { type: 'object', properties: {} } }],
      })
      const call = () =>
        executeMcpToolCall(async () =>
          tools.write!.execute({}, { toolCallId: 'call-1', messages: [], abortSignal: AbortSignal.timeout(1000) }),
        )
      await expect(call()).rejects.toMatchObject({ code: 'tool_outcome_uncertain' })
      expect(calls).toEqual(['tools/call'])
      state.disconnect = false
      await expect(call()).resolves.toMatchObject({ isError: true })
      expect(calls).toEqual(['tools/call', 'tools/call'])
    } finally {
      await client.close()
    }
  })

  it('marks dropped responses and malformed replies after tools/call as uncertain without retrying', async () => {
    const sent: string[] = []
    const fetch = transport(async () => {
      sent.push('sent')
      throw new Error('Socket disconnected')
    })
    await expect(
      executeMcpToolCall(() => fetch('https://tools.example.test', request('tools/call'))),
    ).rejects.toMatchObject({ code: 'tool_outcome_uncertain' })
    expect(sent).toEqual(['sent'])
    const malformed = transport(async () => new Response('invalid json'))
    await expect(
      executeMcpToolCall(async () => (await malformed('https://tools.example.test', request('tools/call'))).json()),
    ).rejects.toMatchObject({ code: 'tool_outcome_uncertain' })
  })

  it('preserves known MCP isError responses without treating the invocation as uncertain', async () => {
    const result = { isError: true, content: [{ type: 'text', text: 'Permission denied by tool' }] }
    const fetch = transport(async () => Response.json(result))
    expect(
      await executeMcpToolCall(async () => (await fetch('https://tools.example.test', request('tools/call'))).json()),
    ).toEqual(result)
  })

  it('keeps pre-dispatch grant and input-validation failures as ordinary failures', async () => {
    const grant = new CloudError(409, 'connection_grant_changed')
    await expect(
      executeMcpToolCall(async () => {
        throw grant
      }),
    ).rejects.toBe(grant)
    const invalid = new Error('Invalid arguments')
    await expect(
      executeMcpToolCall(async () => {
        throw invalid
      }),
    ).rejects.toBe(invalid)
    const fetch = transport(async () => {
      throw new Error('Discovery connection failed')
    })
    await expect(executeMcpToolCall(() => fetch('https://tools.example.test', request('tools/list')))).rejects.toThrow(
      'Discovery connection failed',
    )
  })

  it('isolates dispatch markers across concurrent agents and later invocations', async () => {
    const fetch = transport(async () => {
      throw new Error('Remote failure')
    })
    const [dispatched, untouched] = await Promise.allSettled([
      executeMcpToolCall(() => fetch('https://tools.example.test', request('tools/call'))),
      executeMcpToolCall(async () => {
        await Promise.resolve()
        throw new Error('Grant denied')
      }),
    ])
    expect(dispatched).toMatchObject({ status: 'rejected', reason: { code: 'tool_outcome_uncertain' } })
    expect(untouched).toMatchObject({ status: 'rejected', reason: { message: 'Grant denied' } })
    await expect(
      executeMcpToolCall(async () => {
        throw new Error('Still not sent')
      }),
    ).rejects.toThrow('Still not sent')
  })
})
