/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig } from './agent-config.ts'
import { createMcpRuntime, emptyMcpRuntime, type TransportFactory } from './mcp.ts'

/**
 * A real MCP server over an in-process transport pair. The runtime talks the
 * actual protocol — the only thing stubbed is the transport, so the content
 * mapping and the `isError` convention are exercised as the SDK delivers them
 * rather than as a hand-rolled fake imagines them.
 */
const fakeServer = (opts: { listThrows?: boolean } = {}): Server => {
  const server = new Server({ name: 'fake', version: '1' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, () => {
    if (opts.listThrows) throw new Error('list failed')
    return {
      tools: [
        { name: 'search', title: 'Search docs', description: 'Find a page', inputSchema: { type: 'object' } },
        { name: 'snap', inputSchema: { type: 'object' } },
        { name: 'boom', inputSchema: { type: 'object' } },
        { name: 'silent', inputSchema: { type: 'object' } },
      ],
    }
  })

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    if (request.params.name === 'snap') {
      return {
        content: [
          { type: 'image', data: 'aW1n', mimeType: 'image/jpeg' },
          { type: 'audio', data: 'c25k', mimeType: 'audio/wav' },
        ],
      }
    }
    if (request.params.name === 'boom') {
      return { isError: true, content: [{ type: 'text', text: 'upstream exploded' }] }
    }
    if (request.params.name === 'silent') return { isError: true, content: [] }
    return { content: [{ type: 'text', text: `searched ${JSON.stringify(request.params.arguments)}` }] }
  })

  return server
}

const linkTo = async (server: Server): Promise<Transport> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return clientTransport
}

const stdio = (id: string, trustTools = false): McpServerConfig => ({
  id,
  transport: 'stdio',
  command: 'unused-because-the-transport-is-injected',
  args: [],
  env: {},
  trustTools,
})

/** Builds a runtime whose transports come from a per-id table. */
const runtimeFor = async (
  servers: readonly McpServerConfig[],
  transports: Record<string, Transport | Error>,
): Promise<{ runtime: Awaited<ReturnType<typeof createMcpRuntime>>; reported: string[] }> => {
  const reported: string[] = []
  const buildTransport: TransportFactory = (server) => {
    const entry = transports[server.id]
    if (entry instanceof Error) throw entry
    if (!entry) throw new Error(`no transport for ${server.id}`)
    return entry
  }
  const runtime = await createMcpRuntime(servers, (message) => reported.push(message), buildTransport)
  return { runtime, reported }
}

describe('createMcpRuntime', () => {
  it('returns the frozen empty runtime when nothing is configured', async () => {
    expect(await createMcpRuntime([])).toBe(emptyMcpRuntime)
  })

  it('namespaces every tool by server id', async () => {
    const { runtime } = await runtimeFor([stdio('docs')], { docs: await linkTo(fakeServer()) })

    expect(runtime.tools.map((tool) => tool.name)).toEqual(['docs_search', 'docs_snap', 'docs_boom', 'docs_silent'])
    // A title is preferred for the label; a tool without one falls back to its name.
    expect(runtime.tools[0]?.label).toBe('Search docs')
    expect(runtime.tools[1]?.label).toBe('snap')
    // A tool without a description still gets one naming its server, because a
    // blank description is worse for the model than an attributed placeholder.
    expect(runtime.tools[1]?.description).toBe('snap (via docs)')
    await runtime.dispose()
  })

  it('keeps two servers exposing the same tool name apart', async () => {
    const servers = [stdio('docs'), stdio('wiki')]
    const { runtime } = await runtimeFor(servers, {
      docs: await linkTo(fakeServer()),
      wiki: await linkTo(fakeServer()),
    })

    expect(runtime.tools.filter((tool) => tool.name.endsWith('_search')).map((tool) => tool.name)).toEqual([
      'docs_search',
      'wiki_search',
    ])
    await runtime.dispose()
  })

  it('passes arguments through and maps text content', async () => {
    const { runtime } = await runtimeFor([stdio('docs')], { docs: await linkTo(fakeServer()) })
    const search = runtime.tools.find((tool) => tool.name === 'docs_search')

    const result = await search?.execute('call-1', { query: 'radicle' })

    expect(result?.content).toEqual([{ type: 'text', text: 'searched {"query":"radicle"}' }])
    await runtime.dispose()
  })

  it('maps images and describes content it cannot map', async () => {
    const { runtime } = await runtimeFor([stdio('docs')], { docs: await linkTo(fakeServer()) })
    const snap = runtime.tools.find((tool) => tool.name === 'docs_snap')

    const result = await snap?.execute('call-1', {})

    expect(result?.content).toEqual([
      { type: 'image', data: 'aW1n', mimeType: 'image/jpeg' },
      // Described rather than dropped, so the model is told something arrived.
      { type: 'text', text: '[unsupported MCP content: audio]' },
    ])
    await runtime.dispose()
  })

  it('throws on an isError result so the model sees the failure', async () => {
    // MCP reports a tool failure as a flag on a *successful* response. Returning
    // it as content would hand the model an empty success.
    const { runtime } = await runtimeFor([stdio('docs')], { docs: await linkTo(fakeServer()) })
    const boom = runtime.tools.find((tool) => tool.name === 'docs_boom')

    await expect(boom?.execute('call-1', {})).rejects.toThrow('upstream exploded')
    await runtime.dispose()
  })

  it('names the tool when an isError result carries no text', async () => {
    const { runtime } = await runtimeFor([stdio('docs')], { docs: await linkTo(fakeServer()) })
    const silent = runtime.tools.find((tool) => tool.name === 'docs_silent')

    await expect(silent?.execute('call-1', {})).rejects.toThrow('MCP tool "docs_silent" failed.')
    await runtime.dispose()
  })

  it('collects trusted names only for servers the operator marked', async () => {
    const servers = [stdio('docs', true), stdio('deploy', false)]
    const { runtime } = await runtimeFor(servers, {
      docs: await linkTo(fakeServer()),
      deploy: await linkTo(fakeServer()),
    })

    expect(runtime.trustedToolNames.has('docs_search')).toBe(true)
    expect(runtime.trustedToolNames.has('deploy_search')).toBe(false)
    await runtime.dispose()
  })

  it('reports an unreachable server and still loads the rest', async () => {
    // A hosted agent that refuses to start because one optional integration is
    // down is worse for the team than one missing some tools.
    const servers = [stdio('broken'), stdio('docs')]
    const { runtime, reported } = await runtimeFor(servers, {
      broken: new Error('spawn ENOENT'),
      docs: await linkTo(fakeServer()),
    })

    expect(runtime.tools.map((tool) => tool.name)).toEqual(['docs_search', 'docs_snap', 'docs_boom', 'docs_silent'])
    expect(reported).toEqual(['mcp: broken unavailable — spawn ENOENT', 'mcp: docs connected (4 tools)'])
    await runtime.dispose()
  })

  it('closes the client when listTools fails after a successful connect', async () => {
    // The caller only learns about a client through connectServer's return
    // value, so a client abandoned here would leak for the agent's lifetime —
    // and with stdio, so would the child process it spawned.
    const server = fakeServer({ listThrows: true })
    let closed = false
    server.onclose = () => {
      closed = true
    }

    const { runtime, reported } = await runtimeFor([stdio('docs')], { docs: await linkTo(server) })

    expect(reported[0]).toContain('mcp: docs unavailable')
    expect(runtime.tools).toEqual([])
    expect(closed).toBe(true)
  })

  it('disposes every connected client', async () => {
    const first = fakeServer()
    const second = fakeServer()
    const closed: string[] = []
    first.onclose = () => closed.push('first')
    second.onclose = () => closed.push('second')

    const { runtime } = await runtimeFor([stdio('a'), stdio('b')], {
      a: await linkTo(first),
      b: await linkTo(second),
    })
    await runtime.dispose()

    expect(closed).toContain('first')
    expect(closed).toContain('second')
  })
})
