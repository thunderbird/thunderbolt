/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type FakeMcpCallResult = { text: string; isError?: boolean }

/** A tool the fake server lists. `readOnly` becomes its `readOnlyHint`; leave it out to send no annotations. */
export type FakeMcpTool = {
  name: string
  title?: string
  /** Without it, `The <name> tool`. */
  description?: string
  readOnly?: boolean
  /** What a call returns. Without it a call answers `ok`. */
  call?: (args: Record<string, unknown>) => FakeMcpCallResult | Promise<FakeMcpCallResult>
  /** Answer calls with this result as is, for shapes past plain text: other parts, `structuredContent`, `_meta`. */
  result?: Record<string, unknown>
  /** Answer calls with this JSON-RPC error instead, as a server does for arguments it rejects. */
  rpcError?: { code: number; message: string }
  /** Answer calls with this HTTP status instead, as a failing transport does. */
  httpStatus?: number
}

type JsonRpcMessage = { id?: number | string; method: string; params?: Record<string, unknown> }

/** A request the server received: its HTTP method, and the JSON-RPC method for a POST. */
type FakeMcpRequest = { httpMethod: string; rpcMethod?: string; headers: Headers }

type FakeMcpServerOptions = {
  /** Tools per `tools/list` page. Without it every tool comes in one page. */
  pageSize?: number
}

/** A 499 once the client gives up on `request`, or the server's `stop` drops its connection. */
const whenAbandoned = (request: Request) =>
  new Promise<Response>((resolve) =>
    request.signal.addEventListener('abort', () => resolve(new Response(null, { status: 499 })), { once: true }),
  )

/** An answer that never comes. */
const never = () => new Promise<never>(() => {})

/**
 * A minimal MCP server over Streamable HTTP for the backend's tests, served by `Bun.serve` on loopback. It answers
 * with JSON only and refuses the optional server-to-client stream, which the client tolerates. The e2e suite has a
 * `node:http` sibling for Playwright (`e2e/fake-mcp-server.ts`).
 *
 * It records every request so a test can check what the client sent. Its `state` switches behaviour mid-test:
 * `isFailing` answers every POST with a 500, `isPagingForever` hands out a next cursor on every `tools/list` page,
 * `redirectTo` answers every request with a redirect there, `answerAfter` holds every POST until it resolves, and
 * `stallOn` never answers requests for that JSON-RPC method, or every `DELETE` that ends a session.
 */
export const startFakeMcpServer = (tools: FakeMcpTool[], { pageSize }: FakeMcpServerOptions = {}) => {
  const requests: FakeMcpRequest[] = []
  const state: {
    isFailing: boolean
    isPagingForever: boolean
    redirectTo?: string
    answerAfter?: Promise<void>
    stallOn?: string
  } = {
    isFailing: false,
    isPagingForever: false,
  }

  const listPage = (cursor: unknown) => {
    const start = typeof cursor === 'string' ? Number(cursor) : 0
    const end = pageSize ? start + pageSize : tools.length
    const page = tools.slice(start, end).map(({ name, title, description, readOnly }) => ({
      name,
      ...(title ? { title } : {}),
      description: description ?? `The ${name} tool`,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      ...(readOnly === undefined ? {} : { annotations: { readOnlyHint: readOnly } }),
    }))
    const hasMore = state.isPagingForever || end < tools.length
    return { tools: page, ...(hasMore ? { nextCursor: String(state.isPagingForever ? 0 : end) } : {}) }
  }

  const callTool = async (tool: FakeMcpTool, args: Record<string, unknown>) => {
    if (tool.result) {
      return tool.result
    }
    const { text, isError } = tool.call ? await tool.call(args) : { text: 'ok' }
    return { content: [{ type: 'text', text }], isError }
  }

  /** The JSON-RPC reply to `message`, or the HTTP response a failing tool answers with instead. */
  const answer = async (message: JsonRpcMessage): Promise<Response> => {
    const reply = (result: unknown) =>
      Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers: { 'mcp-session-id': 'fake-session' } })
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        })
      case 'tools/list':
        return reply(listPage(message.params?.cursor))
      case 'tools/call': {
        const tool = tools.find(({ name }) => name === message.params?.name)
        if (!tool) {
          throw new Error(`No tool ${String(message.params?.name)}`)
        }
        if (tool.httpStatus) {
          return new Response('tool failed', { status: tool.httpStatus })
        }
        if (tool.rpcError) {
          return Response.json({ jsonrpc: '2.0', id: message.id, error: tool.rpcError })
        }
        return reply(await callTool(tool, (message.params?.arguments ?? {}) as Record<string, unknown>))
      }
      default:
        throw new Error(`Unexpected method ${message.method}`)
    }
  }

  /** The answer to `request`, which `stallOn`, `answerAfter` or a call that never returns can hold open. */
  const respond = async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      requests.push({ httpMethod: request.method, headers: request.headers })
      if (state.stallOn === request.method) {
        return never()
      }
      return state.redirectTo
        ? Response.redirect(state.redirectTo, 307)
        : new Response(null, { status: request.method === 'DELETE' ? 200 : 405 })
    }
    const message = (await request.json()) as JsonRpcMessage
    requests.push({ httpMethod: request.method, rpcMethod: message.method, headers: request.headers })
    if (state.stallOn === message.method) {
      return never()
    }
    await state.answerAfter
    if (state.redirectTo) {
      return Response.redirect(state.redirectTo, 307)
    }
    if (state.isFailing) {
      return new Response('down', { status: 500 })
    }
    if (message.id === undefined) {
      return new Response(null, { status: 202 })
    }
    return answer(message)
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Raced with the client going away, so a request held open ends with it: `stop` can wait on one forever.
    fetch: (request) => Promise.race([respond(request), whenAbandoned(request)]),
  })

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    requests,
    state,
    /** How many times a client connected, which counts reconnects. */
    connectionCount: () => requests.filter(({ rpcMethod }) => rpcMethod === 'initialize').length,
    stop: () => server.stop(true),
  }
}

export type FakeMcpServer = ReturnType<typeof startFakeMcpServer>
