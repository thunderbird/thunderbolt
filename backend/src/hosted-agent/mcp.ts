/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { withDeadline } from '@/utils/deadline'
import { createMCPClient, type ListToolsResult, type MCPClient } from '@ai-sdk/mcp'
import { sanitizeToolPrefix } from '@shared/mcp-tool-names'
import type { Tool, ToolExecutionOptions, ToolSet } from 'ai'
import type { Logger } from 'pino'
import { z } from 'zod'
import { maxToolCallsPerReply } from './limits'
import { createMcpFetch, McpResponseTooLargeError } from './mcp-fetch'

/**
 * Longest one tool call may take. A whole reply gets two minutes (`agentUpstreamTimeoutMs`), so this leaves room
 * for several calls and the answer after them.
 */
export const mcpToolCallTimeoutMs = 15_000
/**
 * Longest connecting to a server and listing its tools may take, every page included. A reply waits this long
 * for a server that is down before its model starts, so it is kept short.
 */
export const mcpConnectTimeoutMs = 5_000
/** Longest ending a session may take. Nothing waits on it, so this bounds only what a down server holds open. */
const mcpCloseTimeoutMs = 3_000
/** Most `tools/list` pages a server may take. A server that pages past this is treated as broken. */
const maxToolListPages = 20
/** Largest response a server may send, in bytes. The client reads a whole result or tool list before it is capped. */
export const maxMcpResponseBytes = 1_000_000
/** Most tools one server may offer. Every step of every reply carries their definitions, so each one adds cost. */
export const maxToolsPerServer = 32
/** Longest definition one tool may have, in characters of JSON: its title, description and input schema. */
export const maxToolDefinitionChars = 8_000
/** Longest tool result the model is shown, in characters. A result is resent with every later step. */
export const maxToolResultChars = 20_000
/** Longest JSON-RPC error message from a server the model is shown, in characters. */
const maxServerErrorChars = 500

/**
 * Tool names every model provider accepts. OpenAI-compatible APIs take only these characters and cap the name at
 * 64, and one name outside that rejects the whole request, so such a tool is skipped rather than sent.
 */
const providerSafeToolName = /^[a-zA-Z0-9_-]{1,64}$/

/** Whether `fetch` would accept these as request headers. Checked at boot, so a bad one cannot fail every connect. */
const areValidHeaders = (headers: Record<string, string>) => {
  try {
    return Boolean(new Headers(headers))
  } catch {
    return false
  }
}

const agentMcpServerSchema = z.strictObject({
  /** Names the server in logs, prefixes its tools, and appears in the note the model gets while it is down. */
  name: z.string().min(1),
  url: z.url({ protocol: /^https?$/ }),
  /** Sent with every request to the server, for example an `Authorization` header. Never reaches the browser. */
  headers: z
    .record(z.string(), z.string())
    .refine(areValidHeaders, { message: 'must be valid HTTP header names and values' })
    .optional(),
  /** Narrows the server's read-only tools to these names. Without it, every read-only tool the server lists. */
  allowedTools: z.array(z.string().min(1)).min(1).optional(),
})

export type AgentMcpServer = z.infer<typeof agentMcpServerSchema>

const agentMcpServersEnvSchema = z
  .array(agentMcpServerSchema)
  .refine((servers) => new Set(servers.map(({ name }) => name)).size === servers.length, {
    message: 'server names must be unique',
  })

/** `JSON.parse` without the engine's message, which can quote the input, and the input holds credentials. */
const parseServersJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('AGENT_MCP_SERVERS is not valid JSON')
  }
}

/**
 * Parse `AGENT_MCP_SERVERS`, a JSON array of {@link AgentMcpServer}s. Empty means none. A malformed value, an
 * unknown key included, throws, so a typo fails the boot instead of quietly dropping a credential or widening the
 * tools. The message says where the value went wrong but never quotes it, since headers carry credentials.
 */
export const parseAgentMcpServers = (raw: string): AgentMcpServer[] => {
  if (!raw.trim()) {
    return []
  }
  const result = agentMcpServersEnvSchema.safeParse(parseServersJson(raw))
  if (!result.success) {
    const [issue] = result.error.issues
    throw new Error(`AGENT_MCP_SERVERS is invalid at ${issue.path.join('.') || 'the top level'}: ${issue.message}`)
  }
  return result.data
}

/** `base`, or the first of `base_2`, `base_3`, … not yet taken. */
const firstFreePrefix = (base: string, taken: Set<string>, suffix = 1): string => {
  const candidate = suffix === 1 ? base : `${base}_${suffix}`
  return taken.has(candidate) ? firstFreePrefix(base, taken, suffix + 1) : candidate
}

/**
 * Each server's tool prefix: its sanitized name, bumped past any prefix an earlier server took, the way the app's
 * own MCP client namespaces tools (`mergeMcpTools`, `src/ai/fetch.ts`).
 */
const assignPrefixes = (servers: AgentMcpServer[]) => {
  const taken = new Set<string>()
  return servers.map((server) => {
    const prefix = firstFreePrefix(sanitizeToolPrefix(server.name), taken)
    taken.add(prefix)
    return { server, prefix }
  })
}

type McpToolDefinition = ListToolsResult['tools'][number]
type McpTool = ReturnType<MCPClient['toolsFromDefinitions']>[string]

/**
 * How much of a tool's definition a reply carries, in characters: the description and schema the model reads, and
 * the title the browser shows.
 */
const definitionLength = ({ title, annotations, description, inputSchema }: McpToolDefinition) =>
  JSON.stringify({ title: title ?? annotations?.title, description, inputSchema }).length

/** One server's client and the tools it exposes, shared by every run until a failure retires it. */
type Connection = {
  client: MCPClient
  /** Exposed tools by their namespaced name. */
  tools: Map<string, McpTool>
  /** The exposed tools' definitions as JSON, which every step's prompt carries. */
  definitions: string
  /** Calls on this client still running. */
  calls: number
  /** Dropped from the cache after a failure, and closed once its last call settles. */
  isRetired: boolean
  isClosed: boolean
}

/** A connection, and the cached promise it came from, which `forget` matches to leave a newer one alone. */
type CachedConnection = { pending: Promise<Connection>; connection: Connection }

/** One run's tool calls so far, and the servers it could not reconnect to, which its later calls skip. */
type RunState = { calls: number; unreachable: Set<string> }

/** A call's own time limit, and that limit joined with the run's abort, which ends both the call and its claim. */
type CallDeadline = { timeout: AbortSignal; signal: AbortSignal }

/** `promise`'s value, or `undefined` once `signal` aborts. Only the wait ends; the work behind it goes on. */
const unlessAborted = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> => {
  const aborted = Promise.withResolvers<undefined>()
  const onAbort = () => aborted.resolve(undefined)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) {
    onAbort()
  }
  try {
    // Raced even when already aborted, so a rejection of `promise` still has a handler.
    const value = await Promise.race([promise, aborted.promise])
    return signal.aborted ? undefined : value
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** A server that could not be reached or listed. Anything else thrown while connecting is a bug, and propagates. */
class McpServerUnavailableError extends Error {
  constructor(serverName: string, options: ErrorOptions) {
    super(`MCP server ${serverName} is unavailable`, options)
    this.name = 'McpServerUnavailableError'
  }
}

const errorNameOf = (error: unknown) => (error instanceof Error ? error.name : undefined)

/** The HTTP status and JSON-RPC code an MCP client error carries. Neither can hold a credential, so both are logged. */
const errorCodesOf = (error: unknown) => ({
  statusCode:
    error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode
      : undefined,
  code: error instanceof Error && 'code' in error && typeof error.code === 'number' ? error.code : undefined,
})

/** A text part of an MCP tool result. */
const isTextPart = (part: unknown): part is { type: 'text'; text: string } =>
  typeof part === 'object' &&
  part !== null &&
  'type' in part &&
  part.type === 'text' &&
  'text' in part &&
  typeof part.text === 'string'

/** What the model is told for a result with no text in it. */
const noTextContent = '[no text content]'

/** A result part's text, or its type named in its place: the agent reads text only. */
const partText = (part: unknown): string => {
  if (isTextPart(part)) {
    return part.text
  }
  const type = typeof part === 'object' && part !== null && 'type' in part ? String(part.type) : 'unknown'
  return `[${type} content omitted]`
}

/**
 * A tool result's text, with each non-text part named in its place. A result in the old `toolResult` shape is that
 * value as JSON. Nothing else in a result, such as `structuredContent` or `_meta`, is ever read.
 */
const resultText = (result: unknown): string => {
  if (typeof result !== 'object' || result === null) {
    return noTextContent
  }
  if ('content' in result && Array.isArray(result.content)) {
    return result.content.length > 0 ? result.content.map(partText).join('\n') : noTextContent
  }
  if ('toolResult' in result && result.toolResult !== undefined) {
    return JSON.stringify(result.toolResult)
  }
  return noTextContent
}

/**
 * The result as the model and the browser get it: its text, capped, and whether the tool reported an error. The
 * agent takes text only, so images and resources are named rather than sent, and `structuredContent` and `_meta`
 * stay on the server.
 */
const toToolOutput = (result: unknown) => {
  const text = resultText(result)
  const capped =
    text.length > maxToolResultChars
      ? `${text.slice(0, maxToolResultChars)}\n[Result truncated at ${maxToolResultChars} characters]`
      : text
  const isError = typeof result === 'object' && result !== null && 'isError' in result && result.isError === true
  return { content: [{ type: 'text' as const, text: capped }], isError }
}

type CallFailure = {
  /** What the model is told. Raw transport errors can quote the server's response body, so they never reach it. */
  message: string
  /** Whether the connection goes: a dead transport or a server that stopped answering, not the server's own error. */
  shouldRetire: boolean
}

export type AgentMcpToolsResult = {
  tools: ToolSet
  /** The tools' definitions as JSON, which every step's prompt carries, for estimating an aborted run. */
  toolDefinitions: string
  /** Servers that could not be reached for this run, by name. */
  unavailableServers: string[]
  /** Whether the run has made every call its budget allows, so its next step should answer rather than call. */
  isCallBudgetSpent: () => boolean
}

export type AgentMcpClients = {
  /**
   * This run's tools from every reachable server. A server that fails is left out and named, so the run goes ahead.
   * Once `signal` aborts, the run stops waiting on servers still connecting, which it names too; their connects carry
   * on for later runs.
   */
  loadTools: (signal?: AbortSignal) => Promise<AgentMcpToolsResult>
}

type CreateAgentMcpClientsOptions = {
  logger?: Pick<Logger, 'error' | 'info'>
  /** Fetch for the MCP transport: `createApp`'s `fetchFn`, or the unstubbed one in tests. */
  fetchFn?: typeof fetch
  /** Defaults to `mcpToolCallTimeoutMs`. */
  toolCallTimeoutMs?: number
  /** Defaults to `mcpConnectTimeoutMs`. */
  connectTimeoutMs?: number
  /** Defaults to `mcpCloseTimeoutMs`. */
  closeTimeoutMs?: number
}

/**
 * One MCP client per configured server for the life of the process. Each connects and lists its tools, under one
 * deadline, on the first run that needs it; concurrent runs share that connect. Tools are namespaced by server and
 * filtered to the read-only ones the allowlist names, within caps on their number and size. A tool list is fixed for
 * the connection's life. Every request goes through `createMcpFetch`, which caps how much a server can send.
 *
 * A connection is retired when its transport fails or a call times out, and the next call, from any run, reconnects:
 * each call goes to the server's current connection, not the one its run loaded. A retired connection is closed only
 * once no call is using it, since closing aborts every request still in flight on the client. A call the run's own
 * abort cancels, and an error the server returns for that call alone, keep it.
 */
export const createAgentMcpClients = (
  servers: AgentMcpServer[],
  {
    logger,
    fetchFn,
    toolCallTimeoutMs = mcpToolCallTimeoutMs,
    connectTimeoutMs = mcpConnectTimeoutMs,
    closeTimeoutMs = mcpCloseTimeoutMs,
  }: CreateAgentMcpClientsOptions,
): AgentMcpClients => {
  const entries = assignPrefixes(servers)
  const transportFetch = createMcpFetch(fetchFn ?? globalThis.fetch, {
    maxResponseBytes: maxMcpResponseBytes,
    closeTimeoutMs,
  })
  const connections = new Map<string, Promise<Connection>>()
  const loggedNameClashes = new Set<string>()

  /** Log a failed connect once per attempt, by name and codes only: its message can quote the URL or a body. */
  const unavailable = (server: AgentMcpServer, error: unknown) => {
    logger?.error(
      {
        event: 'agent_mcp_server_unavailable',
        server: server.name,
        errorName: errorNameOf(error),
        ...errorCodesOf(error),
      },
      'Agent MCP server unavailable',
    )
    return new McpServerUnavailableError(server.name, { cause: error })
  }

  /** Every page of the server's tool list. Paged by hand because `client.tools()` takes no signal for the deadline. */
  const listAllTools = async (
    client: MCPClient,
    signal: AbortSignal,
    cursor?: string,
    page = 1,
  ): Promise<McpToolDefinition[]> => {
    if (page > maxToolListPages) {
      throw new Error(`The tool list ran past ${maxToolListPages} pages`)
    }
    const { tools, nextCursor } = await client.listTools({
      params: cursor ? { cursor } : undefined,
      options: { signal },
    })
    return nextCursor ? [...tools, ...(await listAllTools(client, signal, nextCursor, page + 1))] : tools
  }

  const openClient = async (server: AgentMcpServer, deadline: AbortSignal) => {
    try {
      return await createMCPClient({
        // `redirect: 'error'` so a redirect cannot carry the server's headers to another origin.
        transport: { type: 'http', url: server.url, headers: server.headers, redirect: 'error', fetch: transportFetch },
        initializationOptions: { signal: deadline },
        clientName: 'thunderbolt-hosted-agent',
        // No `onUncaughtError`: the transport repeats there every failure that also rejects a connect or a call,
        // which are logged where they reject. What reaches only that channel, the optional server-to-client
        // stream, carries nothing a tool call waits on.
      })
    } catch (error) {
      throw unavailable(server, error)
    }
  }

  /** Connect and list the tools: the IO a failing server breaks, so its errors mean the server is unavailable. */
  const openAndList = (server: AgentMcpServer) =>
    withDeadline(connectTimeoutMs, async (deadline) => {
      const client = await openClient(server, deadline)
      try {
        return { client, listed: await listAllTools(client, deadline) }
      } catch (error) {
        // Not awaited: ending the session can take `closeTimeoutMs` on a server that just failed.
        void client.close()
        throw unavailable(server, error)
      }
    })

  /**
   * The tools a connection offers: read-only, allowlisted when the server has a list, safe to name, small enough, and
   * within the server's count, first listed first.
   */
  const expose = (
    server: AgentMcpServer,
    prefix: string,
    client: MCPClient,
    listed: McpToolDefinition[],
  ): Connection => {
    const isReadOnly = (tool: McpToolDefinition) => tool.annotations?.readOnlyHint === true
    const isAllowed = (tool: McpToolDefinition) => !server.allowedTools || server.allowedTools.includes(tool.name)
    const isSafeName = (tool: McpToolDefinition) => providerSafeToolName.test(`${prefix}_${tool.name}`)
    const isSmallEnough = (tool: McpToolDefinition) => definitionLength(tool) <= maxToolDefinitionChars
    const readOnly = listed.filter(isReadOnly)
    const allowed = readOnly.filter(isAllowed)
    const safelyNamed = allowed.filter(isSafeName)
    const smallEnough = safelyNamed.filter(isSmallEnough)
    const exposed = smallEnough.slice(0, maxToolsPerServer)
    const namesOf = (tools: McpToolDefinition[]) => tools.map(({ name }) => name)
    const skipped = {
      notReadOnly: namesOf(listed.filter((tool) => !isReadOnly(tool))),
      notAllowed: namesOf(readOnly.filter((tool) => !isAllowed(tool))),
      unsafeName: namesOf(allowed.filter((tool) => !isSafeName(tool))),
      tooLarge: namesOf(safelyNamed.filter((tool) => !isSmallEnough(tool))),
      pastToolLimit: namesOf(smallEnough.slice(maxToolsPerServer)),
      notListed: (server.allowedTools ?? []).filter((name) => !listed.some((tool) => tool.name === name)),
    }
    if (Object.values(skipped).some((names) => names.length > 0)) {
      logger?.info({ event: 'agent_mcp_tools_skipped', server: server.name, ...skipped }, 'Agent MCP tools skipped')
    }
    const sdkTools = client.toolsFromDefinitions({ tools: exposed })
    return {
      client,
      tools: new Map(exposed.map((tool) => [`${prefix}_${tool.name}`, sdkTools[tool.name]])),
      definitions: JSON.stringify(
        exposed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      ),
      calls: 0,
      isRetired: false,
      isClosed: false,
    }
  }

  /** The shared connection for `server`, connecting it if no run has yet. */
  const getOrConnect = (server: AgentMcpServer, prefix: string) => {
    const cached = connections.get(server.name)
    if (cached) {
      return cached
    }
    const connection = (async () => {
      const { client, listed } = await openAndList(server)
      return expose(server, prefix, client, listed)
    })()
    connections.set(server.name, connection)
    return connection
  }

  /** Drop a pending connection from the cache, unless a newer one already took its place. */
  const forget = (server: AgentMcpServer, pending: Promise<Connection>) => {
    if (connections.get(server.name) === pending) {
      connections.delete(server.name)
    }
  }

  /**
   * `server`'s cached connection, connecting it if there is none, or `undefined` while the server cannot be reached.
   * Anything else thrown while connecting is a bug, and propagates.
   */
  const currentConnection = async (server: AgentMcpServer, prefix: string): Promise<CachedConnection | undefined> => {
    const pending = getOrConnect(server, prefix)
    try {
      return { pending, connection: await pending }
    } catch (error) {
      forget(server, pending)
      if (error instanceof McpServerUnavailableError) {
        return undefined
      }
      throw error
    }
  }

  /**
   * Take a call on `server`'s current connection, which keeps it open until the call settles, or `undefined` if the
   * server cannot be reached before `signal` aborts. A connect other runs share is waited for, never aborted. One that
   * a failure retired, and may have closed, while this waited is passed over for its replacement.
   */
  const claimConnection = async (
    server: AgentMcpServer,
    prefix: string,
    signal: AbortSignal,
  ): Promise<CachedConnection | undefined> => {
    const current = await unlessAborted(currentConnection(server, prefix), signal)
    if (!current) {
      return undefined
    }
    if (current.connection.isRetired) {
      return claimConnection(server, prefix, signal)
    }
    // In the same tick as the check above, so the connection cannot close in between.
    current.connection.calls += 1
    return current
  }

  /** Close a retired connection once no call is using it: closing aborts every request still in flight on it. */
  const closeIfIdle = (connection: Connection) => {
    if (!connection.isRetired || connection.calls > 0 || connection.isClosed) {
      return
    }
    connection.isClosed = true
    // Not awaited: ending the session can take `closeTimeoutMs` on a server that just failed.
    void connection.client.close()
  }

  /** Take a broken connection out of use: the next call reconnects, and it closes once its last call settles. */
  const retire = (server: AgentMcpServer, pending: Promise<Connection>, connection: Connection) => {
    forget(server, pending)
    connection.isRetired = true
    closeIfIdle(connection)
  }

  const didNotAnswer = (server: AgentMcpServer) =>
    `${server.name} did not answer within ${toolCallTimeoutMs / 1000} seconds.`

  /**
   * What the model is told about a failed call, and whether the connection goes with it. Only a timeout or a failed
   * transport retires it; the server's own error, or a response too large to read, leaves it for other calls.
   */
  const describeFailure = (server: AgentMcpServer, error: unknown, timedOut: boolean): CallFailure => {
    if (timedOut) {
      return { message: didNotAnswer(server), shouldRetire: true }
    }
    // Only this response was cut off; the session is fine.
    if (error instanceof McpResponseTooLargeError) {
      return {
        message: `${server.name} returned more than ${maxMcpResponseBytes / 1_000_000} MB, which is too much to read.`,
        shouldRetire: false,
      }
    }
    const { statusCode, code } = errorCodesOf(error)
    if (code !== undefined) {
      const detail = error instanceof Error ? error.message.slice(0, maxServerErrorChars) : ''
      return { message: `${server.name} returned an error: ${detail}`, shouldRetire: false }
    }
    return {
      message: `${server.name} could not be reached${statusCode ? ` (HTTP ${statusCode})` : ''}.`,
      shouldRetire: true,
    }
  }

  /** Call `name` on a claimed connection within the call's deadline. A timeout or a failed transport retires it. */
  const callOn = async (
    server: AgentMcpServer,
    { pending, connection }: CachedConnection,
    name: string,
    input: unknown,
    options: ToolExecutionOptions,
    { timeout, signal }: CallDeadline,
  ) => {
    const tool = connection.tools.get(name)
    // A reconnect lists the tools again, so this one may have gone or lost its read-only hint since the run loaded it.
    if (!tool) {
      throw new Error(`${server.name} no longer offers ${name}.`)
    }
    try {
      return toToolOutput(await tool.execute(input, { ...options, abortSignal: signal }))
    } catch (error) {
      // The run is ending anyway, and nothing will read what the model would have been told.
      if (options.abortSignal?.aborted) {
        throw error
      }
      const { message, shouldRetire } = describeFailure(server, error, timeout.aborted)
      logger?.error(
        {
          event: 'agent_mcp_tool_call_failed',
          server: server.name,
          tool: name,
          errorName: errorNameOf(error),
          ...errorCodesOf(error),
          timedOut: timeout.aborted,
          retired: shouldRetire,
        },
        'Agent MCP tool call failed',
      )
      if (shouldRetire) {
        retire(server, pending, connection)
      }
      throw new Error(message, { cause: error })
    }
  }

  /**
   * `tool` as one run calls it: under the run's call budget, on the server's current connection, with a model-safe
   * result. The run keeps `tool`'s definition, but never its client, which another run's failure may have closed.
   */
  const forRun = (server: AgentMcpServer, prefix: string, name: string, tool: McpTool, run: RunState): Tool => ({
    ...tool,
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      if (run.calls >= maxToolCallsPerReply) {
        throw new Error(`This reply has used its ${maxToolCallsPerReply} tool calls. Answer with what you have.`)
      }
      run.calls += 1
      // Started before the claim, so the call's limit covers a reconnect, and Stop ends the wait for one.
      return withDeadline(toolCallTimeoutMs, async (timeout) => {
        const deadline = {
          timeout,
          signal: options.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout,
        }
        // After one failed reconnect, the run's later calls skip the server rather than each wait on a connect.
        const claimed = run.unreachable.has(server.name)
          ? undefined
          : await claimConnection(server, prefix, deadline.signal)
        if (!claimed) {
          // A wait the call's limit or Stop cut short says nothing of the server: its reconnect may just be slow.
          if (!deadline.signal.aborted) {
            run.unreachable.add(server.name)
          }
          throw new Error(timeout.aborted ? didNotAnswer(server) : `${server.name} could not be reached.`)
        }
        try {
          return await callOn(server, claimed, name, input, options, deadline)
        } finally {
          claimed.connection.calls -= 1
          closeIfIdle(claimed.connection)
        }
      })
    },
  })

  const loadTools = async (signal = new AbortController().signal): Promise<AgentMcpToolsResult> => {
    const loaded = await Promise.all(
      entries.map(async ({ server, prefix }) => ({
        server,
        prefix,
        current: await unlessAborted(currentConnection(server, prefix), signal),
      })),
    )
    const run: RunState = { calls: 0, unreachable: new Set() }
    // A Map, then `Object.fromEntries`, so a tool named like an object property stays an ordinary tool.
    const tools = new Map<string, Tool>()
    const definitions: string[] = []
    const unavailableServers: string[] = []
    for (const { server, prefix, current } of loaded) {
      if (!current) {
        unavailableServers.push(server.name)
        continue
      }
      definitions.push(current.connection.definitions)
      for (const [name, tool] of current.connection.tools) {
        if (tools.has(name)) {
          if (!loggedNameClashes.has(name)) {
            loggedNameClashes.add(name)
            logger?.info(
              { event: 'agent_mcp_tools_skipped', server: server.name, nameTaken: [name] },
              'Agent MCP tool skipped: an earlier server has a tool with that name',
            )
          }
          continue
        }
        tools.set(name, forRun(server, prefix, name, tool, run))
      }
    }
    return {
      tools: Object.fromEntries(tools),
      toolDefinitions: definitions.join('\n'),
      unavailableServers,
      isCallBudgetSpent: () => run.calls >= maxToolCallsPerReply,
    }
  }

  return { loadTools }
}
