/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { startFakeMcpServer, type FakeMcpServer, type FakeMcpTool } from '@/test-utils/fake-mcp-server'
import { realFetch } from '@/test-utils/real-fetch'
import type { Tool, ToolExecutionOptions } from 'ai'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { maxToolCallsPerReply } from './limits'
import {
  createAgentMcpClients,
  maxMcpResponseBytes,
  maxToolDefinitionChars,
  maxToolResultChars,
  maxToolsPerServer,
  parseAgentMcpServers,
  type AgentMcpServer,
} from './mcp'

/** Call a loaded tool the way the AI SDK does. */
const callTool = (tool: Tool | undefined, abortSignal?: AbortSignal) => {
  if (!tool?.execute) {
    throw new Error('Tool has no execute')
  }
  const options: ToolExecutionOptions = { toolCallId: 'call-1', messages: [], abortSignal }
  return tool.execute({ query: 'robots' }, options)
}

/** A call handler that never answers, for timeouts and aborts. */
const neverAnswers = () => new Promise<never>(() => {})

describe('parseAgentMcpServers', () => {
  it.each(['', '   '])('returns no servers for %p', (raw) => {
    expect(parseAgentMcpServers(raw)).toEqual([])
  })

  it('reads a name, url, headers and tool allowlist', () => {
    const servers = [
      {
        name: 'schedule',
        url: 'https://schedule.example.com/mcp',
        headers: { Authorization: 'Bearer token' },
        allowedTools: ['search_sessions'],
      },
    ]
    expect(parseAgentMcpServers(JSON.stringify(servers))).toEqual(servers)
  })

  it('refuses invalid JSON without quoting it, since it holds credentials', () => {
    const parse = () => parseAgentMcpServers('[{"headers":{"Authorization":"Bearer sekret"')
    expect(parse).toThrow('AGENT_MCP_SERVERS is not valid JSON')
    expect(parse).not.toThrow(/sekret/)
  })

  it.each([
    ['a value that is not an array', { name: 'a', url: 'https://a.example.com' }, 'the top level'],
    ['a url that is not http(s)', [{ name: 'a', url: 'ftp://a.example.com' }], '0.url'],
    ['a missing name', [{ url: 'https://a.example.com' }], '0.name'],
    ['a header that is not a string', [{ name: 'a', url: 'https://a.example.com', headers: { X: 1 } }], '0.headers.X'],
    [
      'a header fetch would refuse',
      [{ name: 'a', url: 'https://a.example.com', headers: { 'Bad Name': 'x' } }],
      '0.headers',
    ],
    ['an empty tool allowlist', [{ name: 'a', url: 'https://a.example.com', allowedTools: [] }], '0.allowedTools'],
    [
      'a misspelled key, which would drop the allowlist',
      [{ name: 'a', url: 'https://a.example.com', allowedTool: ['x'] }],
      '0',
    ],
  ])('refuses %s, naming where', (_label, value, path) => {
    expect(() => parseAgentMcpServers(JSON.stringify(value))).toThrow(`AGENT_MCP_SERVERS is invalid at ${path}:`)
  })

  it('refuses two servers with the same name', () => {
    const servers = [
      { name: 'a', url: 'https://a.example.com' },
      { name: 'a', url: 'https://b.example.com' },
    ]
    expect(() => parseAgentMcpServers(JSON.stringify(servers))).toThrow('server names must be unique')
  })
})

describe('createAgentMcpClients', () => {
  const servers: FakeMcpServer[] = []
  const startServer = (tools: FakeMcpTool[], options?: Parameters<typeof startFakeMcpServer>[1]) => {
    const server = startFakeMcpServer(tools, options)
    servers.push(server)
    return server
  }
  /** A url nothing listens on: a server started and stopped again. */
  const deadUrl = async () => {
    const server = startFakeMcpServer([])
    await server.stop()
    return server.url
  }
  const logger = { error: mock(), info: mock() }
  const create = (config: AgentMcpServer[], timeouts: { toolCallTimeoutMs?: number; connectTimeoutMs?: number } = {}) =>
    createAgentMcpClients(config, { logger, fetchFn: realFetch, ...timeouts })

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()))
    logger.error.mockClear()
    logger.info.mockClear()
  })

  it('loads no tools and names no server when none are configured', async () => {
    expect(await create([]).loadTools()).toMatchObject({ tools: {}, toolDefinitions: '', unavailableServers: [] })
  })

  it("namespaces each tool under its server's name, and keeps its title", async () => {
    const server = startServer([{ name: 'search_sessions', title: 'Search the schedule', readOnly: true }])
    const { tools } = await create([{ name: 'MozFest Schedule', url: server.url }]).loadTools()
    expect(Object.keys(tools)).toEqual(['mozfest_schedule_search_sessions'])
    expect(tools.mozfest_schedule_search_sessions.title).toBe('Search the schedule')
  })

  it('gives servers whose names sanitize alike their own prefixes', async () => {
    const first = startServer([{ name: 'search', readOnly: true }])
    const second = startServer([{ name: 'search', readOnly: true }])
    const { tools } = await create([
      { name: 'My Server', url: first.url },
      { name: 'my-server', url: second.url },
    ]).loadTools()
    expect(Object.keys(tools)).toEqual(['my_server_search', 'my_server_2_search'])
  })

  it('exposes only the read-only tools, and logs the rest once per connection', async () => {
    const server = startServer([
      { name: 'search_sessions', readOnly: true },
      { name: 'book_seat', readOnly: false },
      { name: 'unannotated' },
    ])
    const clients = create([{ name: 'schedule', url: server.url }])
    const { tools } = await clients.loadTools()
    await clients.loadTools()
    expect(Object.keys(tools)).toEqual(['schedule_search_sessions'])
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent_mcp_tools_skipped', notReadOnly: ['book_seat', 'unannotated'] }),
      expect.any(String),
    )
  })

  it('narrows the read-only tools to the allowlist, which cannot add a tool that is not read-only', async () => {
    const server = startServer([
      { name: 'search_sessions', readOnly: true },
      { name: 'list_rooms', readOnly: true },
      { name: 'book_seat', readOnly: false },
    ])
    const { tools } = await create([
      { name: 'schedule', url: server.url, allowedTools: ['list_rooms', 'book_seat', 'missing_tool'] },
    ]).loadTools()
    expect(Object.keys(tools)).toEqual(['schedule_list_rooms'])
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        notReadOnly: ['book_seat'],
        notAllowed: ['search_sessions'],
        notListed: ['missing_tool'],
      }),
      expect.any(String),
    )
  })

  it('skips a tool whose name a model provider would refuse, which would otherwise reject every request', async () => {
    const server = startServer([
      { name: 'sessions.search', readOnly: true },
      { name: 'search_sessions', readOnly: true },
    ])
    const { tools } = await create([{ name: 'schedule', url: server.url }]).loadTools()
    expect(Object.keys(tools)).toEqual(['schedule_search_sessions'])
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ unsafeName: ['sessions.search'] }),
      expect.any(String),
    )
  })

  it('reads every page of a paged tool list', async () => {
    const server = startServer(
      [
        { name: 'search_sessions', readOnly: true },
        { name: 'list_rooms', readOnly: true },
        { name: 'get_session', readOnly: true },
      ],
      { pageSize: 2 },
    )
    const { tools } = await create([{ name: 'schedule', url: server.url }]).loadTools()
    expect(Object.keys(tools)).toEqual(['schedule_search_sessions', 'schedule_list_rooms', 'schedule_get_session'])
  })

  it('skips a tool whose definition is too large to carry on every step, and keeps the rest', async () => {
    const server = startServer([
      { name: 'search_sessions', readOnly: true, description: 'x'.repeat(maxToolDefinitionChars) },
      { name: 'list_rooms', readOnly: true },
    ])
    const { tools } = await create([{ name: 'schedule', url: server.url }]).loadTools()
    expect(Object.keys(tools)).toEqual(['schedule_list_rooms'])
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tooLarge: ['search_sessions'] }),
      expect.any(String),
    )
  })

  it(`offers at most ${maxToolsPerServer} tools from one server, the first listed`, async () => {
    const listed = Array.from({ length: maxToolsPerServer + 2 }, (_, index) => ({
      name: `tool_${index}`,
      readOnly: true,
    }))
    const server = startServer(listed)
    const { tools } = await create([{ name: 'schedule', url: server.url }]).loadTools()
    expect(Object.keys(tools)).toEqual(listed.slice(0, maxToolsPerServer).map(({ name }) => `schedule_${name}`))
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ pastToolLimit: [`tool_${maxToolsPerServer}`, `tool_${maxToolsPerServer + 1}`] }),
      expect.any(String),
    )
  })

  it('gives up on a server whose tool list never ends, so it cannot hang every reply', async () => {
    const server = startServer([{ name: 'search_sessions', readOnly: true }])
    server.state.isPagingForever = true
    expect((await create([{ name: 'schedule', url: server.url }]).loadTools()).unavailableServers).toEqual(['schedule'])
  })

  it.each(['initialize', 'tools/list'])(
    'gives up on a server that never answers %s, within the connect deadline',
    async (method) => {
      const server = startServer([{ name: 'search_sessions', readOnly: true }])
      server.state.stallOn = method
      const started = performance.now()
      const result = await create([{ name: 'schedule', url: server.url }], { connectTimeoutMs: 200 }).loadTools()
      expect(result.unavailableServers).toEqual(['schedule'])
      expect(performance.now() - started).toBeLessThan(1_000)
    },
  )

  it('stops waiting on a first connect once the visitor leaves, and lets it finish for later runs', async () => {
    const server = startServer([{ name: 'search_sessions', readOnly: true }])
    const held = Promise.withResolvers<void>()
    server.state.answerAfter = held.promise
    const clients = create([{ name: 'schedule', url: server.url }], { connectTimeoutMs: 10_000 })
    const visitor = new AbortController()
    const started = performance.now()
    const loading = clients.loadTools(visitor.signal)
    visitor.abort()
    expect((await loading).unavailableServers).toEqual(['schedule'])
    expect(performance.now() - started).toBeLessThan(1_000)
    server.state.answerAfter = undefined
    held.resolve()
    expect((await clients.loadTools()).unavailableServers).toEqual([])
    expect(server.connectionCount()).toBe(1)
  })

  it('sends the configured headers with every request', async () => {
    const server = startServer([{ name: 'search_sessions', readOnly: true }])
    const { tools } = await create([
      { name: 'schedule', url: server.url, headers: { Authorization: 'Bearer schedule-token' } },
    ]).loadTools()
    await callTool(tools.schedule_search_sessions)
    const posts = server.requests.filter(({ httpMethod }) => httpMethod === 'POST')
    expect(posts.map(({ rpcMethod }) => rpcMethod)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ])
    expect(server.requests.every(({ headers }) => headers.get('authorization') === 'Bearer schedule-token')).toBe(true)
  })

  it("returns the server's text, and none of the result the model does not read", async () => {
    const server = startServer([
      { name: 'search_sessions', readOnly: true, call: ({ query }) => ({ text: `Sessions about ${String(query)}` }) },
    ])
    const { tools } = await create([{ name: 'schedule', url: server.url }]).loadTools()
    expect(await callTool(tools.schedule_search_sessions)).toEqual({
      content: [{ type: 'text', text: 'Sessions about robots' }],
      isError: false,
    })
  })

  it.each([
    [
      'text beside other parts, naming them and keeping its structured content and metadata out',
      {
        content: [
          { type: 'text', text: 'Robots: Room 2, 14:00' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        structuredContent: { room: 'Room 2' },
        _meta: { trace: 'trace-1' },
      },
      'Robots: Room 2, 14:00\n[image content omitted]',
    ],
    [
      'structured content alone as no text',
      { structuredContent: { room: 'Room 2' }, _meta: { trace: 'trace-1' } },
      '[no text content]',
    ],
    ['no parts as no text', { content: [] }, '[no text content]'],
    [
      'the old toolResult shape as that value alone',
      { toolResult: { sessions: 2 }, _meta: { trace: 'trace-1' } },
      '{"sessions":2}',
    ],
  ])('reads a result with %s', async (_label, result, text) => {
    const server = startServer([{ name: 'search_sessions', readOnly: true, result }])
    const { tools } = await create([{ name: 'schedule', url: server.url }]).loadTools()
    expect(await callTool(tools.schedule_search_sessions)).toEqual({
      content: [{ type: 'text', text }],
      isError: false,
    })
  })

  it('caps a long result', async () => {
    const long = 'x'.repeat(maxToolResultChars + 5)
    const server = startServer([{ name: 'search_sessions', readOnly: true, call: () => ({ text: long }) }])
    const { tools } = await create([{ name: 'schedule', url: server.url }]).loadTools()
    const { content } = (await callTool(tools.schedule_search_sessions)) as { content: { text: string }[] }
    expect(content[0].text).toBe(
      `${'x'.repeat(maxToolResultChars)}\n[Result truncated at ${maxToolResultChars} characters]`,
    )
  })

  it('refuses calls past the per-reply budget, says when it is spent, and starts a fresh one for the next reply', async () => {
    const server = startServer([{ name: 'search_sessions', readOnly: true }])
    const clients = create([{ name: 'schedule', url: server.url }])
    const { tools, isCallBudgetSpent } = await clients.loadTools()
    await Promise.all(Array.from({ length: maxToolCallsPerReply - 1 }, () => callTool(tools.schedule_search_sessions)))
    expect(isCallBudgetSpent()).toBe(false)
    await callTool(tools.schedule_search_sessions)
    expect(isCallBudgetSpent()).toBe(true)
    await expect(callTool(tools.schedule_search_sessions)).rejects.toThrow(
      `used its ${maxToolCallsPerReply} tool calls`,
    )
    const next = await clients.loadTools()
    expect(next.isCallBudgetSpent()).toBe(false)
    expect(await callTool(next.tools.schedule_search_sessions)).toMatchObject({ isError: false })
  })

  it('refuses a result larger than a response may be, and keeps the connection', async () => {
    const server = startServer([
      { name: 'search_sessions', readOnly: true, call: () => ({ text: 'x'.repeat(maxMcpResponseBytes) }) },
    ])
    const clients = create([{ name: 'schedule', url: server.url }])
    const { tools } = await clients.loadTools()
    await expect(callTool(tools.schedule_search_sessions)).rejects.toThrow(
      'schedule returned more than 1 MB, which is too much to read.',
    )
    await clients.loadTools()
    expect(server.connectionCount()).toBe(1)
  })

  it('connects once for concurrent first runs and reuses the connection after', async () => {
    const server = startServer([{ name: 'search_sessions', readOnly: true }])
    const clients = create([{ name: 'schedule', url: server.url }])
    await Promise.all([clients.loadTools(), clients.loadTools()])
    await clients.loadTools()
    expect(server.connectionCount()).toBe(1)
  })

  it('names a server it cannot reach and still loads the others', async () => {
    const server = startServer([{ name: 'search_sessions', readOnly: true }])
    const result = await create([
      { name: 'down', url: await deadUrl() },
      { name: 'schedule', url: server.url },
    ]).loadTools()
    expect(Object.keys(result.tools)).toEqual(['schedule_search_sessions'])
    expect(result.unavailableServers).toEqual(['down'])
  })

  it('logs an unreachable server once per attempt, by its name, error name and codes only', async () => {
    const server = startServer([])
    server.state.isFailing = true
    const clients = create([{ name: 'schedule', url: server.url }])
    await Promise.all([clients.loadTools(), clients.loadTools()])
    expect(logger.error).toHaveBeenCalledTimes(1)
    const [fields] = logger.error.mock.calls[0]
    expect(Object.keys(fields).sort()).toEqual(['code', 'errorName', 'event', 'server', 'statusCode'])
    expect(fields).toMatchObject({ event: 'agent_mcp_server_unavailable', server: 'schedule', statusCode: 500 })
  })

  it('refuses to follow a redirect, so the headers never reach another origin', async () => {
    const elsewhere = startServer([{ name: 'search_sessions', readOnly: true }])
    const server = startServer([])
    server.state.redirectTo = elsewhere.url
    const result = await create([
      { name: 'schedule', url: server.url, headers: { Authorization: 'Bearer schedule-token' } },
    ]).loadTools()
    expect(result.unavailableServers).toEqual(['schedule'])
    expect(elsewhere.requests).toEqual([])
  })

  it('tries again on the next run after a failed connect', async () => {
    const server = startServer([{ name: 'search_sessions', readOnly: true }])
    const clients = create([{ name: 'schedule', url: server.url }])
    server.state.isFailing = true
    expect((await clients.loadTools()).unavailableServers).toEqual(['schedule'])
    server.state.isFailing = false
    const retry = await clients.loadTools()
    expect(retry.unavailableServers).toEqual([])
    expect(Object.keys(retry.tools)).toEqual(['schedule_search_sessions'])
  })

  it('reconnects on the next run after a transport failure, and tells the model only that it failed', async () => {
    const server = startServer([{ name: 'search_sessions', readOnly: true, httpStatus: 502 }])
    const clients = create([{ name: 'schedule', url: server.url }])
    const { tools } = await clients.loadTools()
    await expect(callTool(tools.schedule_search_sessions)).rejects.toThrow(
      /^schedule could not be reached \(HTTP 502\)\.$/,
    )
    await clients.loadTools()
    expect(server.connectionCount()).toBe(2)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'agent_mcp_tool_call_failed',
        server: 'schedule',
        tool: 'schedule_search_sessions',
        statusCode: 502,
        retired: true,
      }),
      expect.any(String),
    )
  })

  it("keeps the connection for the server's own error, and hands the model its message", async () => {
    const server = startServer([
      { name: 'search_sessions', readOnly: true, rpcError: { code: -32602, message: 'day must be YYYY-MM-DD' } },
    ])
    const clients = create([{ name: 'schedule', url: server.url }])
    const { tools } = await clients.loadTools()
    await expect(callTool(tools.schedule_search_sessions)).rejects.toThrow(
      'schedule returned an error: day must be YYYY-MM-DD',
    )
    await clients.loadTools()
    expect(server.connectionCount()).toBe(1)
  })

  it('keeps the connection when the tool reports its own failure', async () => {
    const server = startServer([
      { name: 'search_sessions', readOnly: true, call: () => ({ text: 'No such day', isError: true }) },
    ])
    const clients = create([{ name: 'schedule', url: server.url }])
    const { tools } = await clients.loadTools()
    expect(await callTool(tools.schedule_search_sessions)).toEqual({
      content: [{ type: 'text', text: 'No such day' }],
      isError: true,
    })
    await clients.loadTools()
    expect(server.connectionCount()).toBe(1)
  })

  it("does not abort another run's call when a transport failure retires the connection", async () => {
    const slow = Promise.withResolvers<void>()
    const server = startServer([
      {
        name: 'slow_search',
        readOnly: true,
        call: async () => {
          await slow.promise
          return { text: 'finished' }
        },
      },
      { name: 'broken_search', readOnly: true, httpStatus: 503 },
    ])
    const clients = create([{ name: 'schedule', url: server.url }])
    const { tools } = await clients.loadTools()
    const inFlight = callTool(tools.schedule_slow_search)
    await expect(callTool(tools.schedule_broken_search)).rejects.toThrow('could not be reached')
    slow.resolve()
    expect(await inFlight).toMatchObject({ content: [{ text: 'finished' }] })
  })

  it('gives up on ending a session the server never answers, so a retired connection holds nothing open', async () => {
    const server = startServer([{ name: 'broken_search', readOnly: true, httpStatus: 503 }])
    server.state.stallOn = 'DELETE'
    const sessionEnd = Promise.withResolvers<Response>()
    const fetchFn = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = realFetch(input, init)
        if (init?.method === 'DELETE') {
          sessionEnd.resolve(response)
        }
        return response
      },
      { preconnect: realFetch.preconnect },
    )
    const clients = createAgentMcpClients([{ name: 'schedule', url: server.url }], {
      logger,
      fetchFn,
      closeTimeoutMs: 100,
    })
    const { tools } = await clients.loadTools()
    const started = performance.now()
    await expect(callTool(tools.schedule_broken_search)).rejects.toThrow('could not be reached')
    await expect(sessionEnd.promise).rejects.toThrow('timed out')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('tells the model a slow call timed out, and reconnects for the next run', async () => {
    const server = startServer([{ name: 'search_sessions', readOnly: true, call: neverAnswers }])
    const clients = create([{ name: 'schedule', url: server.url }], { toolCallTimeoutMs: 50 })
    const { tools } = await clients.loadTools()
    await expect(callTool(tools.schedule_search_sessions)).rejects.toThrow(
      'schedule did not answer within 0.05 seconds.',
    )
    await clients.loadTools()
    expect(server.connectionCount()).toBe(2)
  })

  it("passes the run's abort to the call, and keeps the connection", async () => {
    const server = startServer([{ name: 'search_sessions', readOnly: true, call: neverAnswers }])
    const clients = create([{ name: 'schedule', url: server.url }])
    const { tools } = await clients.loadTools()
    const stop = new AbortController()
    const call = callTool(tools.schedule_search_sessions, stop.signal)
    stop.abort()
    await expect(call).rejects.toThrow()
    await clients.loadTools()
    expect(server.connectionCount()).toBe(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("moves another run's calls to a new connection once a failure retires the one it loaded", async () => {
    const server = startServer([
      { name: 'search_sessions', readOnly: true },
      { name: 'broken_search', readOnly: true, httpStatus: 503 },
    ])
    const clients = create([{ name: 'schedule', url: server.url }])
    const [first, second] = await Promise.all([clients.loadTools(), clients.loadTools()])
    await expect(callTool(first.tools.schedule_broken_search)).rejects.toThrow('could not be reached')
    expect(await callTool(second.tools.schedule_search_sessions)).toMatchObject({ isError: false })
    expect(server.connectionCount()).toBe(2)
  })

  it('tries one reconnect per reply to a server that stays down, and tells the model only that it is unreachable', async () => {
    const server = startServer([
      { name: 'search_sessions', readOnly: true },
      { name: 'broken_search', readOnly: true, httpStatus: 503 },
    ])
    const clients = create([{ name: 'schedule', url: server.url }])
    const { tools } = await clients.loadTools()
    await expect(callTool(tools.schedule_broken_search)).rejects.toThrow('could not be reached (HTTP 503)')
    server.state.isFailing = true
    await expect(callTool(tools.schedule_search_sessions)).rejects.toThrow(/^schedule could not be reached\.$/)
    await expect(callTool(tools.schedule_search_sessions)).rejects.toThrow(/^schedule could not be reached\.$/)
    expect(server.connectionCount()).toBe(2)
    server.state.isFailing = false
    expect((await clients.loadTools()).unavailableServers).toEqual([])
  })

  it('stops waiting for a reconnect when the run is aborted, and lets the connect finish for later runs', async () => {
    const server = startServer([
      { name: 'search_sessions', readOnly: true },
      { name: 'broken_search', readOnly: true, httpStatus: 503 },
    ])
    const clients = create([{ name: 'schedule', url: server.url }], { connectTimeoutMs: 10_000 })
    const { tools } = await clients.loadTools()
    await expect(callTool(tools.schedule_broken_search)).rejects.toThrow('could not be reached')
    const held = Promise.withResolvers<void>()
    server.state.answerAfter = held.promise
    const stop = new AbortController()
    const started = performance.now()
    const call = callTool(tools.schedule_search_sessions, stop.signal)
    stop.abort()
    await expect(call).rejects.toThrow('could not be reached')
    // Well short of the connect deadline, which a call that waited for the reconnect would have run into.
    expect(performance.now() - started).toBeLessThan(1_000)
    server.state.answerAfter = undefined
    held.resolve()
    const next = await clients.loadTools()
    expect(await callTool(next.tools.schedule_search_sessions)).toMatchObject({ isError: false })
    expect(server.connectionCount()).toBe(2)
  })

  it("counts a reconnect against the call's time limit", async () => {
    const server = startServer([
      { name: 'search_sessions', readOnly: true },
      { name: 'broken_search', readOnly: true, httpStatus: 503 },
    ])
    const clients = create([{ name: 'schedule', url: server.url }], {
      toolCallTimeoutMs: 500,
      connectTimeoutMs: 10_000,
    })
    const { tools } = await clients.loadTools()
    await expect(callTool(tools.schedule_broken_search)).rejects.toThrow('could not be reached')
    const held = Promise.withResolvers<void>()
    server.state.answerAfter = held.promise
    const started = performance.now()
    await expect(callTool(tools.schedule_search_sessions)).rejects.toThrow(/^schedule could not be reached\.$/)
    // The call's own 500 ms limit, not the connect deadline.
    expect(performance.now() - started).toBeLessThan(2_000)
    server.state.answerAfter = undefined
    held.resolve()
    // Let the reconnect finish here rather than log into the next test.
    expect((await clients.loadTools()).unavailableServers).toEqual([])
  })

  it('refuses a call once a reconnect finds the tool is no longer read-only', async () => {
    const listed: FakeMcpTool[] = [
      { name: 'search_sessions', readOnly: true },
      { name: 'broken_search', readOnly: true, httpStatus: 503 },
    ]
    const server = startServer(listed)
    const { tools } = await create([{ name: 'schedule', url: server.url }]).loadTools()
    await expect(callTool(tools.schedule_broken_search)).rejects.toThrow('could not be reached')
    listed[0].readOnly = false
    await expect(callTool(tools.schedule_search_sessions)).rejects.toThrow(
      'schedule no longer offers schedule_search_sessions.',
    )
    expect(server.requests.filter(({ rpcMethod }) => rpcMethod === 'tools/call')).toHaveLength(1)
  })

  it('leaves a newer connection alone when a call on the one it replaced fails', async () => {
    const server = startServer([
      { name: 'slow_search', readOnly: true, call: neverAnswers },
      { name: 'broken_search', readOnly: true, httpStatus: 502 },
    ])
    const clients = create([{ name: 'schedule', url: server.url }], { toolCallTimeoutMs: 500 })
    const { tools } = await clients.loadTools()
    const inFlight = callTool(tools.schedule_slow_search)
    await expect(callTool(tools.schedule_broken_search)).rejects.toThrow('could not be reached')
    await clients.loadTools()
    // Times out on the retired connection after the new one is cached.
    await expect(inFlight).rejects.toThrow('did not answer')
    await clients.loadTools()
    expect(server.connectionCount()).toBe(2)
  })

  it('keeps a tool named like an object property as an ordinary tool', async () => {
    const server = startServer([
      { name: 'constructor', readOnly: true },
      { name: 'toString', readOnly: true },
    ])
    const { tools } = await create([{ name: 'x', url: server.url }]).loadTools()
    expect(Object.keys(tools).sort()).toEqual(['x_constructor', 'x_toString'])
    expect(Object.getPrototypeOf(tools)).toBe(Object.prototype)
  })

  it("returns the tools' definitions, which every step's prompt carries", async () => {
    const server = startServer([{ name: 'search_sessions', readOnly: true }])
    const { toolDefinitions } = await create([{ name: 'schedule', url: server.url }]).loadTools()
    expect(JSON.parse(toolDefinitions)).toEqual([
      expect.objectContaining({ name: 'search_sessions', description: 'The search_sessions tool' }),
    ])
  })
})
