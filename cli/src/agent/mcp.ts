/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * MCP tools for the served agent.
 *
 * `shared/agent-core/mcp-tools.ts` already converts MCP tools into Pi tools,
 * but it converts *AI-SDK* tools, and reaching them means pulling `ai` and
 * `@ai-sdk/mcp` into a binary that ships as a single compiled executable. Going
 * at the MCP SDK directly costs one conversion function and avoids that weight
 * — and the direct path is the simpler of the two anyway, because MCP hands us
 * JSON Schema and content blocks that already match what Pi wants. The browser
 * harness keeps using the AI-SDK path; the two do not share a runtime.
 *
 * Tool names are namespaced `<serverId>_<tool>`, matching `mergeMcpTools` in
 * the app, so a model that has seen one convention sees the same here and two
 * servers exposing `search` do not collide.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig } from './agent-config.ts'

/** Pi's structural type for a tool's `parameters` (a TypeBox `TSchema`). */
type PiToolParameters = AgentTool['parameters']

/** Separator between server id and tool name. Mirrors the app's namespacing. */
const nameSeparator = '_'

export type McpRuntime = {
  readonly tools: readonly AgentTool[]
  /** Tool names whose server is marked `trustTools`. */
  readonly trustedToolNames: ReadonlySet<string>
  readonly dispose: () => Promise<void>
}

export const emptyMcpRuntime: McpRuntime = Object.freeze({
  tools: [],
  trustedToolNames: new Set<string>(),
  dispose: async () => {},
})

/**
 * Pi accepts a plain JSON Schema object at runtime — it compiles one directly
 * and reads `.properties`/`.required` off it — so the schema passes through
 * untouched and this only satisfies the structural brand at the boundary.
 * Same reasoning as `asPiParameters` in the shared module.
 */
const asPiParameters = (jsonSchema: object): PiToolParameters => jsonSchema as unknown as PiToolParameters

type McpContentBlock = { type: string; text?: string; data?: string; mimeType?: string }

/** Map MCP content blocks onto Pi's text/image content. Anything else is
 *  described rather than dropped, so the model is told something arrived. */
const toPiContent = (blocks: readonly McpContentBlock[]) =>
  blocks.map((block) => {
    if (block.type === 'text') return { type: 'text' as const, text: block.text ?? '' }
    if (block.type === 'image' && block.data) {
      return { type: 'image' as const, data: block.data, mimeType: block.mimeType ?? 'image/png' }
    }
    return { type: 'text' as const, text: `[unsupported MCP content: ${block.type}]` }
  })

/** Builds the client transport a server's config describes. Injected so tests
 *  can link a client to an in-process server instead of spawning one. */
export type TransportFactory = (server: McpServerConfig) => Transport

const createTransport: TransportFactory = (server) => {
  if (server.transport === 'stdio') {
    return new StdioClientTransport({
      command: server.command as string,
      args: [...(server.args ?? [])],
      // Passed env is merged over the SDK's own safelist — it always includes
      // `getDefaultEnvironment()` (HOME, PATH, SHELL, TERM, USER on POSIX), so
      // this narrows rather than isolates. That is the part that matters: the
      // served agent's environment also holds the Thunderbolt credential and
      // whatever else the host injects, and none of that is on the safelist.
      // Verified by spawning a server that echoes its own environment.
      env: { ...(server.env ?? {}) },
    })
  }
  return new StreamableHTTPClientTransport(new URL(server.url as string), {
    requestInit: { headers: { ...(server.headers ?? {}) } },
  })
}

/**
 * List a connected client's tools, closing it if that fails.
 *
 * The caller only learns about a client through this function's return value,
 * so a `connect` that succeeds followed by a `listTools` that does not would
 * otherwise orphan the client — and, for stdio, the child process it spawned —
 * for the lifetime of the agent.
 */
const listToolsOrClose = async (client: Client) => {
  try {
    return await client.listTools()
  } catch (error) {
    try {
      await client.close()
    } catch {
      // Already gone. Reporting this would bury the failure we are rethrowing.
    }
    throw error
  }
}

const connectServer = async (
  server: McpServerConfig,
  buildTransport: TransportFactory,
): Promise<{ client: Client; tools: AgentTool[] }> => {
  const client = new Client({ name: 'thunderbolt-agent', version: '1' }, { capabilities: {} })
  await client.connect(buildTransport(server))

  const listed = await listToolsOrClose(client)
  const tools: AgentTool[] = listed.tools.map((tool) => {
    const namespaced = `${server.id}${nameSeparator}${tool.name}`
    return {
      name: namespaced,
      label: tool.title ?? tool.name,
      description: tool.description ?? `${tool.name} (via ${server.id})`,
      parameters: asPiParameters(tool.inputSchema ?? { type: 'object', properties: {} }),
      execute: async (_toolCallId, params, signal) => {
        // Pi hands `params` as `unknown` (validated against the schema Pi
        // compiled from this tool's own inputSchema); MCP wants a record.
        const args = params as Record<string, unknown>
        const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal })
        const blocks = (result.content ?? []) as McpContentBlock[]
        // MCP reports tool failures as a flag on a successful response rather
        // than an error. Throw so Pi encodes it as a tool-result error — the
        // model needs to see the failure, not an empty success.
        if (result.isError) {
          const text = blocks.map((block) => block.text ?? '').join('\n')
          throw new Error(text || `MCP tool "${namespaced}" failed.`)
        }
        return { content: toPiContent(blocks), details: result }
      },
    }
  })

  return { client, tools }
}

/**
 * Connect every configured server and collect their tools.
 *
 * One unreachable server does not take down the agent: its failure is reported
 * and the rest still load. A hosted agent that refuses to start because a
 * single optional integration is down is worse for the team than one missing
 * some tools, and the startup log names what is missing.
 */
export const createMcpRuntime = async (
  servers: readonly McpServerConfig[],
  report: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
  buildTransport: TransportFactory = createTransport,
): Promise<McpRuntime> => {
  if (servers.length === 0) return emptyMcpRuntime

  const clients: Client[] = []
  const tools: AgentTool[] = []
  const trustedToolNames = new Set<string>()

  for (const server of servers) {
    try {
      const connected = await connectServer(server, buildTransport)
      clients.push(connected.client)
      for (const tool of connected.tools) {
        tools.push(tool)
        if (server.trustTools) trustedToolNames.add(tool.name)
      }
      report(`mcp: ${server.id} connected (${connected.tools.length} tools)`)
    } catch (error) {
      report(`mcp: ${server.id} unavailable — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    tools,
    trustedToolNames,
    dispose: async () => {
      await Promise.all(
        clients.map(async (client) => {
          try {
            await client.close()
          } catch {
            // Already gone. Teardown must not mask the reason the agent is stopping.
          }
        }),
      )
    },
  }
}
