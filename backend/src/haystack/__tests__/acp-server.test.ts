/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for HaystackAcpServer's JSON-RPC dispatch and Haystack→ACP
 * translation. We exercise the protocol surface end-to-end without an actual
 * websocket: the `send` callback collects outbound frames into an array, and
 * `fetchFn` is injected per backend/docs/testing.md to mock the upstream.
 *
 * Skipped on purpose: trivial getters (capabilities flat fields), DTO
 * passthrough (already covered by the SDK schema types). We test branching
 * and lifecycle.
 */

import type { Settings } from '@/config/settings'
import { AGENT_METHODS, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'bun:test'
import { HaystackAcpServer } from '../acp-server'

const buildSettings = (overrides: Partial<Settings> = {}): Settings =>
  ({
    haystackBaseUrl: 'https://haystack.test',
    haystackApiKey: 'test-key',
    haystackPipelines: '',
    logLevel: 'INFO',
    ...overrides,
  }) as Settings

/**
 * Build an SSE response body from a list of events. Each event is encoded as
 * `data: {json}\n\n`. The returned Response.body is a ReadableStream that
 * the parser can consume.
 */
const sseResponse = (events: Array<Record<string, unknown>>): Response => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

type Captured = { method?: string; url?: string; body?: unknown; signal?: AbortSignal }

const buildServer = (opts: {
  upstream?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>
  sessionIds?: string[]
  pipelineId?: string
}) => {
  const sent: string[] = []
  const captures: Captured[] = []
  const baseFetch = opts.upstream ?? (() => Promise.resolve(sseResponse([{ type: 'done' }])))
  const wrappedFetchImpl = (input: URL | RequestInfo, init?: RequestInit) => {
    captures.push({
      method: init?.method,
      url: input.toString(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal ?? undefined,
    })
    return baseFetch(input, init)
  }
  const wrappedFetch = Object.assign(wrappedFetchImpl, { preconnect: () => {} }) as unknown as typeof fetch
  const idQueue = [...(opts.sessionIds ?? [])]
  const server = new HaystackAcpServer({
    send: (payload) => sent.push(payload),
    pipelineId: opts.pipelineId ?? 'pipe-1',
    settings: buildSettings(),
    deps: {
      fetchFn: wrappedFetch,
      generateSessionId: idQueue.length > 0 ? () => idQueue.shift() ?? crypto.randomUUID() : undefined,
    },
  })
  return { server, sent, captures }
}

type CapturedSessionUpdate = {
  sessionId: string
  update: { sessionUpdate: 'agent_message_chunk'; content: { type: 'text'; text: string } }
}

/** Parse only those outbound frames whose `method` matches `session/update`. */
const sessionUpdates = (sent: string[]): CapturedSessionUpdate[] =>
  sent
    .map((s) => JSON.parse(s) as { method?: string; params?: CapturedSessionUpdate })
    .filter((m): m is { method: string; params: CapturedSessionUpdate } => m.method === 'session/update' && !!m.params)
    .map((m) => m.params)

const findResponse = (sent: string[], id: string | number) => sent.map((s) => JSON.parse(s)).find((m) => m.id === id)

describe('HaystackAcpServer', () => {
  it('replies to initialize with the MVP capability set', async () => {
    const { server, sent } = buildServer({})
    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.initialize }))
    const reply = findResponse(sent, 1)
    expect(reply.result).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'Thunderbolt Haystack Adapter', version: '1.0.0' },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
    })
  })

  it('returns a UUID sessionId on session/new and persists internal context', async () => {
    const { server, sent } = buildServer({ sessionIds: ['ses-aaa'] })
    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: AGENT_METHODS.session_new }))
    const reply = findResponse(sent, 'r1')
    expect(reply.result.sessionId).toBe('ses-aaa')
    // Echo through a session/prompt to confirm the session was registered.
    // Use an immediate-done upstream so no actual streaming runs.
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'r2',
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-aaa', prompt: [{ type: 'text', text: 'hi' }] },
      }),
    )
    const promptReply = findResponse(sent, 'r2')
    expect(promptReply.result).toEqual({ stopReason: 'end_turn' })
  })

  it('forwards Haystack deltas as agent_message_chunk session/update notifications', async () => {
    const upstream = () =>
      Promise.resolve(
        sseResponse([
          { type: 'delta', text: 'Hello ' },
          { type: 'delta', text: 'world' },
          { type: 'done', stopReason: 'end_turn' },
        ]),
      )
    const { server, sent, captures } = buildServer({ upstream, sessionIds: ['ses-stream'], pipelineId: 'rag-v1' })
    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-stream', prompt: [{ type: 'text', text: 'Say hi' }] },
      }),
    )

    // Upstream call shape.
    expect(captures.length).toBe(1)
    expect(captures[0].method).toBe('POST')
    expect(captures[0].url).toBe('https://haystack.test/runs')
    expect(captures[0].body).toEqual({ pipeline_id: 'rag-v1', query: 'Say hi', stream: true })

    // session/update notifications carry the agent_message_chunk text in order.
    const updates = sessionUpdates(sent)
    expect(updates).toEqual([
      {
        sessionId: 'ses-stream',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
      },
      {
        sessionId: 'ses-stream',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
      },
    ])

    // Prompt response carries the stop reason.
    expect(findResponse(sent, 2).result).toEqual({ stopReason: 'end_turn' })
  })

  it('aborts the upstream fetch when session/cancel is received mid-stream', async () => {
    let capturedSignal: AbortSignal | null = null
    let releaseChunk: () => void = () => {}
    const chunkLanded = new Promise<void>((resolve) => {
      releaseChunk = resolve
    })
    const upstream = (_input: URL | RequestInfo, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              capturedSignal = init?.signal ?? null
              const enc = new TextEncoder()
              controller.enqueue(enc.encode('data: {"type":"delta","text":"start"}\n\n'))
              releaseChunk()
              init?.signal?.addEventListener('abort', () => {
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
              })
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )

    const { server, sent } = buildServer({ upstream, sessionIds: ['ses-cancel'] })
    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    const promptPromise = server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-cancel', prompt: [{ type: 'text', text: 'go' }] },
      }),
    )

    // Wait until the first delta has streamed so we know the request is in flight.
    await chunkLanded
    // Notification — no `id` field; matches JSON-RPC 2.0.
    await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: AGENT_METHODS.session_cancel, params: { sessionId: 'ses-cancel' } }),
    )
    await promptPromise

    expect(capturedSignal).not.toBeNull()
    expect(capturedSignal!.aborted).toBe(true)
    expect(findResponse(sent, 2).result).toEqual({ stopReason: 'cancelled' })
  })

  it('isolates two concurrent sessions on the same socket', async () => {
    const responseFactory = (label: string) => () =>
      Promise.resolve(sseResponse([{ type: 'delta', text: label }, { type: 'done' }]))

    const sent: string[] = []
    let upstreamCalls = 0
    const fetchImpl = (_input: URL | RequestInfo, _init?: RequestInit) => {
      upstreamCalls += 1
      return upstreamCalls === 1 ? responseFactory('A')() : responseFactory('B')()
    }
    const fetchFn = Object.assign(fetchImpl, { preconnect: () => {} }) as unknown as typeof fetch
    const idQueue = ['ses-A', 'ses-B']
    const server = new HaystackAcpServer({
      send: (payload) => sent.push(payload),
      pipelineId: 'rag',
      settings: buildSettings(),
      deps: { fetchFn, generateSessionId: () => idQueue.shift() ?? crypto.randomUUID() },
    })

    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: AGENT_METHODS.session_new }))
    await Promise.all([
      server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: AGENT_METHODS.session_prompt,
          params: { sessionId: 'ses-A', prompt: [{ type: 'text', text: 'a?' }] },
        }),
      ),
      server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: AGENT_METHODS.session_prompt,
          params: { sessionId: 'ses-B', prompt: [{ type: 'text', text: 'b?' }] },
        }),
      ),
    ])

    const updates = sessionUpdates(sent)
    const aUpdates = updates.filter((u) => u.sessionId === 'ses-A')
    const bUpdates = updates.filter((u) => u.sessionId === 'ses-B')
    expect(aUpdates.map((u) => u.update.content.text)).toEqual(['A'])
    expect(bUpdates.map((u) => u.update.content.text)).toEqual(['B'])
  })
})
