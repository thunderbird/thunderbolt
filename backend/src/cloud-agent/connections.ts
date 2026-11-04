/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { and, eq, ne } from 'drizzle-orm'
import { cloudConnections } from '@/db/cloud-agent-schema'
import { createMcpFetch } from '@/hosted-agent/mcp-fetch'
import { validateAndPin, type DnsLookup } from '@/utils/url-validation'
import type { CloudAgentService, ConnectionRow } from './service'
import { CloudError } from './errors'
import { refreshCloudConnection } from './oauth'
import { createMcpDispatchFetch, executeMcpToolCall } from './mcp-dispatch'

/** Cloud credentials never follow redirects or an MCP-provided endpoint to a different origin. */
export const createConnectionFetch = (
  origin: string,
  fetchFn: typeof fetch = fetch,
  dnsLookup?: DnsLookup,
): typeof fetch => {
  const dispatch = createMcpDispatchFetch(fetchFn)
  const pinned = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.protocol !== 'https:' || url.origin !== origin) {
      throw new CloudError(422, 'connection_origin_mismatch')
    }
    const [target, headers, tls] = await validateAndPin(url.href, request.headers, dnsLookup)
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    const response = await dispatch(target, {
      method: request.method,
      body,
      headers,
      tls,
      redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new CloudError(422, 'connection_redirect_refused')
    }
    return response
  }
  const network = createMcpFetch(Object.assign(pinned, { preconnect: fetchFn.preconnect }), {
    maxResponseBytes: 2_000_000,
    closeTimeoutMs: 2000,
  })
  const request = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try {
      return await network(input, init)
    } catch (error) {
      if (error instanceof CloudError) {
        throw error
      }
      // This boundary contains only URL validation, DNS, HTTP and response limits; credential DB reads wrap it.
      throw new CloudError(502, 'connection_request_failed')
    }
  }
  return Object.assign(request, { preconnect: fetchFn.preconnect })
}

/** Classify protocol/setup failures separately from database, storage and encryption failures. */
export const runMcpSetup = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    if (
      error instanceof Error &&
      ['MCPClientError', 'AI_MCPClientError', 'AI_TypeValidationError', 'SyntaxError'].includes(error.name)
    ) {
      throw new CloudError(502, 'mcp_setup_failed')
    }
    throw error
  }
}

type ConnectionBinding = Pick<
  ConnectionRow,
  'id' | 'userId' | 'version' | 'keyEpoch' | 'credentialVersion' | 'enabled' | 'deletedAt'
>

/** A captured MCP token may reach the network only while its exact live credential grant is unchanged. */
export const createBoundConnectionFetch = (
  bound: ConnectionBinding,
  current: () => Promise<ConnectionBinding>,
  upstream: typeof fetch,
): typeof fetch => {
  const checked = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const live = await current()
    if (
      !live.enabled ||
      live.deletedAt ||
      live.id !== bound.id ||
      live.userId !== bound.userId ||
      live.version !== bound.version ||
      live.keyEpoch !== bound.keyEpoch ||
      live.credentialVersion !== bound.credentialVersion
    ) {
      throw new CloudError(409, 'connection_grant_changed')
    }
    return upstream(input, init)
  }
  return Object.assign(checked, { preconnect: upstream.preconnect })
}

/** Each saved connection owns its credentials; agent selection is checked again for every invocation. */
export const connectCloudMcp = async (service: CloudAgentService, initial: ConnectionRow): Promise<MCPClient> => {
  const row = await refreshCloudConnection(service, initial)
  if (!row.enabled) {
    throw new CloudError(409, 'connection_disabled')
  }
  const { config } = await service.openConnection(row)
  if (config.kind !== 'mcp') {
    throw new CloudError(422, 'not_an_mcp_connection')
  }
  const token =
    config.authentication.type === 'none'
      ? null
      : config.authentication.type === 'bearer'
        ? config.authentication.token
        : config.authentication.accessToken
  const upstream = createConnectionFetch(new URL(config.url).origin)
  const checked = createBoundConnectionFetch(row, () => refreshCloudConnection(service, row), upstream)
  return runMcpSetup(() =>
    createMCPClient({
      initializationOptions: { timeout: 15_000 },
      // The runtime owns recovery; SDK retries cannot safely repeat an arbitrary remote side effect.
      maxRetries: 0,
      transport: {
        type: 'http',
        url: config.url,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        fetch: checked,
      },
    }),
  )
}

const unavailableConnectionCodes = new Set([
  'connection_not_found',
  'connection_disabled',
  'connection_needs_authorization',
  'connection_grant_changed',
  'connection_origin_mismatch',
  'connection_redirect_refused',
  'connection_request_failed',
  'not_an_mcp_connection',
  'mcp_setup_failed',
  'mcp_tool_limit_exceeded',
  'mcp_tool_definition_invalid',
])

type CloudMcpClient = Pick<MCPClient, 'close' | 'listTools'> & {
  toolsFromDefinitions: (
    definitions: Parameters<MCPClient['toolsFromDefinitions']>[0],
  ) => ReturnType<MCPClient['toolsFromDefinitions']>
}

/** Fixed limits bound discovery and model context; tool metadata does not confer replay safety. */
export const loadMcpTools = async (
  service: CloudAgentService,
  ownerId: string,
  agentId: string,
  connectionIds: string[],
  connect: (service: CloudAgentService, row: ConnectionRow) => Promise<CloudMcpClient> = connectCloudMcp,
) => {
  const clients: CloudMcpClient[] = []
  const tools: ToolRegistration[] = []
  const unavailable: { connectionId: string; name: string; code: string }[] = []
  const sourceIds: string[] = []
  try {
    for (const connectionId of connectionIds) {
      const pending: { client?: CloudMcpClient; name: string } = { name: connectionId }
      try {
        const initial = await service.getConnection(ownerId, connectionId)
        const { config: initialConfig } = await service.openConnection(initial)
        pending.name = initialConfig.name
        if (initialConfig.libraryRef?.kind === 'mcp') {
          sourceIds.push(initialConfig.libraryRef.id)
        }
        const row = await refreshCloudConnection(service, initial)
        const { config } = await service.openConnection(row)
        const client = await connect(service, row)
        pending.client = client
        const listing = await runMcpSetup(() => client.listTools({ options: { timeout: 15_000 } }))
        if (listing.nextCursor || listing.tools.length > 64) {
          throw new CloudError(422, 'mcp_tool_limit_exceeded')
        }
        const selected = listing.tools.filter((tool) => !config.allowedTools || config.allowedTools.includes(tool.name))
        for (const definition of selected) {
          if (!/^[a-zA-Z0-9_-]{1,40}$/.test(definition.name) || JSON.stringify(definition).length > 16_000) {
            throw new CloudError(422, 'mcp_tool_definition_invalid')
          }
        }
        const executable = client.toolsFromDefinitions({ tools: selected })
        const connectionTools = selected.map((definition) => {
          const name = `mcp_${connectionId.replaceAll('-', '').slice(0, 12)}_${definition.name}`
          return defineTool({
            name,
            description: definition.description ?? definition.name,
            parameters: Type.Unsafe<Record<string, unknown>>(definition.inputSchema),
            replay: 'unsafe',
            executionMode: 'sequential',
            execute: async (args, api) => {
              const [agent, current] = await Promise.all([
                service.getAgent(ownerId, agentId),
                refreshCloudConnection(service, row),
              ])
              const { config: currentAgent } = await service.openAgent(agent)
              if (
                !agent.enabled ||
                !current.enabled ||
                current.version !== row.version ||
                current.keyEpoch !== row.keyEpoch ||
                current.credentialVersion !== row.credentialVersion ||
                !currentAgent.connectionIds.includes(connectionId)
              ) {
                throw new CloudError(409, 'connection_grant_changed')
              }
              const tool = executable[definition.name]
              if (!tool.execute) {
                throw new CloudError(422, 'mcp_tool_unavailable')
              }
              const execute = tool.execute
              const result = await executeMcpToolCall(async () =>
                execute(args, {
                  toolCallId: api.callId,
                  messages: [],
                  abortSignal: AbortSignal.timeout(60_000),
                }),
              )
              const serialized = JSON.stringify(result)
              return {
                output: [{ type: 'text', text: serialized.slice(0, 40_000) }],
                ...(serialized.length > 40_000 && {
                  diagnostics: [{ severity: 'warn', message: 'Tool output truncated at 40000 characters.' }],
                }),
              }
            },
          })
        })
        tools.push(...connectionTools)
        clients.push(client)
      } catch (error) {
        if (pending.client) {
          await Promise.allSettled([pending.client.close()])
        }
        if (!(error instanceof CloudError) || !unavailableConnectionCodes.has(error.code)) {
          throw error
        }
        unavailable.push({ connectionId, name: pending.name, code: error.code })
      }
    }
    return {
      tools,
      unavailable,
      sourceIds,
      dispose: async () => {
        await Promise.allSettled(clients.map((client) => client.close()))
      },
    }
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()))
    throw error
  }
}

/** Test authentication and discovery without executing any remote tool. */
export const testConnection = async (service: CloudAgentService, ownerId: string, connectionId: string) => {
  const connection = await service.getConnection(ownerId, connectionId)
  const { config } = await service.openConnection(connection)
  if (config.kind === 'model') {
    return { status: 'unverified', tools: [] }
  }
  try {
    const client = await connectCloudMcp(service, connection)
    try {
      const result = await client.listTools({ options: { timeout: 15_000 } })
      await service.database
        .update(cloudConnections)
        .set({ status: 'ready' })
        .where(eq(cloudConnections.id, connectionId))
      return { status: 'ready', tools: result.tools.map((tool) => tool.name) }
    } finally {
      await client.close()
    }
  } catch {
    await service.database
      .update(cloudConnections)
      .set({ status: 'unreachable' })
      .where(and(eq(cloudConnections.id, connectionId), ne(cloudConnections.status, 'needs-authorization')))
    throw new CloudError(502, 'connection_test_failed')
  }
}
