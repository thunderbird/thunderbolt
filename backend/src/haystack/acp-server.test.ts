/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for HaystackAcpServer's JSON-RPC dispatch and Deepset→ACP translation.
 *
 * We exercise the protocol surface end-to-end without an actual websocket:
 *  - `send` callback collects outbound JSON-RPC frames into an array.
 *  - `fetchFn` is injected per backend/docs/testing.md to mock the upstream
 *    (no `mock.module` — see docs/development/testing.md).
 *
 * Coverage focus:
 *  - 2-step Deepset flow (POST /search_sessions, then POST /chat-stream).
 *  - Cold-pipeline retry: a 503 whose body carries Deepset's "temporarily
 *    unavailable" marker is retried; any other 5xx fails fast.
 *  - SSE delta translation into `session/update` notifications.
 *  - Authorization header propagation.
 *  - Workspace embedded in the URL.
 *  - Cancellation aborts both the upstream stream and the prompt response.
 */

import type { Settings } from '@/config/settings'
import { AGENT_METHODS, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'bun:test'
import { HaystackAcpServer } from './acp-server'

const buildSettings = (overrides: Partial<Settings> = {}): Settings =>
  ({
    haystackBaseUrl: 'https://haystack.test',
    haystackApiKey: 'test-key',
    haystackWorkspace: 'ws-test',
    haystackPipelines: '',
    logLevel: 'INFO',
    ...overrides,
  }) as Settings

/** Encode events as Deepset SSE frames and wrap them in a Response body. */
const sseResponse = (frames: Array<Record<string, unknown> | '[DONE]'>): Response => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        const payload = frame === '[DONE]' ? '[DONE]' : JSON.stringify(frame)
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Captured = {
  method?: string
  url?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

type Upstream = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

const buildServer = (opts: {
  upstream: Upstream
  sessionIds?: string[]
  pipelineId?: string
  pipelineName?: string
  settings?: Partial<Settings>
  persistentSearchSessions?: Map<string, string>
}) => {
  const sent: string[] = []
  const captures: Captured[] = []
  const wrappedFetchImpl = (input: URL | RequestInfo, init?: RequestInit) => {
    const rawHeaders = init?.headers
    const headerRecord: Record<string, string> = {}
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headerRecord[k] = v
        })
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) {
          headerRecord[k] = v
        }
      } else {
        Object.assign(headerRecord, rawHeaders)
      }
    }
    captures.push({
      method: init?.method,
      url: input.toString(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: headerRecord,
      signal: init?.signal ?? undefined,
    })
    return opts.upstream(input, init)
  }
  const wrappedFetch = Object.assign(wrappedFetchImpl, { preconnect: () => {} }) as unknown as typeof fetch
  const idQueue = [...(opts.sessionIds ?? [])]
  const server = new HaystackAcpServer({
    send: (payload) => sent.push(payload),
    pipelineId: opts.pipelineId ?? 'pipe-uuid-1',
    pipelineName: opts.pipelineName ?? 'pipe-slug-1',
    settings: buildSettings(opts.settings),
    deps: {
      fetchFn: wrappedFetch,
      generateSessionId: idQueue.length > 0 ? () => idQueue.shift() ?? crypto.randomUUID() : undefined,
      retryBaseDelayMs: 0,
      persistentSearchSessions: opts.persistentSearchSessions ?? new Map<string, string>(),
    },
  })
  return { server, sent, captures }
}

type CapturedSessionUpdate = {
  sessionId: string
  update: { sessionUpdate: 'agent_message_chunk'; content: { type: 'text'; text: string } }
  _meta?: Record<string, unknown>
}

const sessionUpdates = (sent: string[]): CapturedSessionUpdate[] =>
  sent
    .map((s) => JSON.parse(s) as { method?: string; params?: CapturedSessionUpdate })
    .filter((m): m is { method: string; params: CapturedSessionUpdate } => m.method === 'session/update' && !!m.params)
    .map((m) => m.params)

const findResponse = (sent: string[], id: string | number) => sent.map((s) => JSON.parse(s)).find((m) => m.id === id)

/** Build a happy-path upstream: first call is search_sessions, then chat-stream. */
const happyUpstream = (chatFrames: Array<Record<string, unknown> | '[DONE]'>): Upstream => {
  let call = 0
  return (input) => {
    call += 1
    const url = input.toString()
    if (call === 1) {
      expect(url).toContain('/search_sessions')
      return Promise.resolve(jsonResponse(200, { search_session_id: 'deepset-sess-1' }))
    }
    expect(url).toContain('/chat-stream')
    return Promise.resolve(sseResponse(chatFrames))
  }
}

describe('HaystackAcpServer', () => {
  it('replies to initialize advertising loadSession + plaintext-only prompt capabilities', async () => {
    const { server, sent } = buildServer({ upstream: () => Promise.resolve(sseResponse(['[DONE]'])) })
    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.initialize }))
    const reply = findResponse(sent, 1)
    expect(reply.result).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'Thunderbolt Haystack Adapter', version: '1.0.0' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
    })
  })

  it('bootstraps a search_session then streams chat-stream deltas (2-step flow)', async () => {
    const { server, sent, captures } = buildServer({
      upstream: happyUpstream([
        { type: 'delta', delta: { text: 'Hello ' } },
        { type: 'delta', delta: { text: 'world' } },
        '[DONE]',
      ]),
      sessionIds: ['ses-stream'],
      pipelineId: 'pipe-uuid-rag',
      pipelineName: 'rag-pipeline',
    })

    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-stream', prompt: [{ type: 'text', text: 'Say hi' }] },
      }),
    )

    // Step 1: search_sessions bootstrap.
    expect(captures[0].method).toBe('POST')
    expect(captures[0].url).toBe('https://haystack.test/api/v1/workspaces/ws-test/search_sessions')
    expect(captures[0].body).toEqual({ pipeline_id: 'pipe-uuid-rag' })
    expect(captures[0].headers?.authorization).toBe('Bearer test-key')

    // Step 2: chat-stream.
    expect(captures[1].method).toBe('POST')
    expect(captures[1].url).toBe('https://haystack.test/api/v1/workspaces/ws-test/pipelines/rag-pipeline/chat-stream')
    expect(captures[1].body).toEqual({
      query: 'Say hi',
      search_session_id: 'deepset-sess-1',
      include_result: true,
    })
    expect(captures[1].headers?.accept).toBe('text/event-stream')
    expect(captures[1].headers?.authorization).toBe('Bearer test-key')

    const updates = sessionUpdates(sent)
    expect(updates.map((u) => u.update.content.text)).toEqual(['Hello ', 'world'])
    expect(findResponse(sent, 2).result.stopReason).toBe('end_turn')
  })

  it('retries a transient 503 (cold pipeline) on chat-stream until it warms up', async () => {
    // Ground truth: Deepset answers a waking pipeline with 503 + body
    // `{"errors":["The pipeline '<name>' is temporarily unavailable. ..."]}`.
    // The retry is gated on that body marker, not the bare status.
    let chatAttempts = 0
    const upstream: Upstream = (input) => {
      const url = input.toString()
      if (url.endsWith('/search_sessions')) {
        return Promise.resolve(jsonResponse(200, { search_session_id: 'sess-cold' }))
      }
      chatAttempts += 1
      if (chatAttempts < 3) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ errors: ["The pipeline 'rag' is temporarily unavailable. Try again in a few moments."] }),
            { status: 503 },
          ),
        )
      }
      return Promise.resolve(sseResponse([{ type: 'delta', delta: { text: 'warmed' } }, '[DONE]']))
    }

    const { server, sent } = buildServer({ upstream, sessionIds: ['ses-cold'] })

    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-cold', prompt: [{ type: 'text', text: 'warm up' }] },
      }),
    )

    expect(chatAttempts).toBe(3)
    const updates = sessionUpdates(sent)
    expect(updates.map((u) => u.update.content.text)).toEqual(['warmed'])
    expect(findResponse(sent, 2).result.stopReason).toBe('end_turn')
  })

  it('fails fast on a non-transient 5xx (no cold-pipeline marker, no retry)', async () => {
    // A genuine outage: 503 without the "temporarily unavailable" marker must
    // throw on the first response rather than triggering a retry storm.
    let chatAttempts = 0
    const upstream: Upstream = (input) => {
      const url = input.toString()
      if (url.endsWith('/search_sessions')) {
        return Promise.resolve(jsonResponse(200, { search_session_id: 'sess-outage' }))
      }
      chatAttempts += 1
      return Promise.resolve(new Response('upstream connect error', { status: 503 }))
    }

    const { server, sent } = buildServer({ upstream, sessionIds: ['ses-outage'] })

    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-outage', prompt: [{ type: 'text', text: 'go' }] },
      }),
    )

    expect(chatAttempts).toBe(1)
    const reply = findResponse(sent, 2)
    expect(reply.error).toBeDefined()
    expect(reply.error.message).toContain('503')
    expect(reply.error.message).toContain('upstream connect error')
  })

  it('retries a transient 503 (cold pipeline) on the search_sessions bootstrap', async () => {
    // The search_sessions call routes through fetchWithPipelineRetry too, so a
    // cold pipeline on bootstrap must wake-and-retry the same way.
    let searchAttempts = 0
    const upstream: Upstream = (input) => {
      const url = input.toString()
      if (url.endsWith('/search_sessions')) {
        searchAttempts += 1
        if (searchAttempts < 2) {
          return Promise.resolve(
            new Response('The pipeline is temporarily unavailable. Try again in a few moments.', { status: 503 }),
          )
        }
        return Promise.resolve(jsonResponse(200, { search_session_id: 'sess-warm' }))
      }
      return Promise.resolve(sseResponse([{ type: 'delta', delta: { text: 'ok' } }, '[DONE]']))
    }

    const { server, sent } = buildServer({ upstream, sessionIds: ['ses-bootstrap'] })

    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-bootstrap', prompt: [{ type: 'text', text: 'go' }] },
      }),
    )

    expect(searchAttempts).toBe(2)
    expect(sessionUpdates(sent).map((u) => u.update.content.text)).toEqual(['ok'])
    expect(findResponse(sent, 2).result.stopReason).toBe('end_turn')
  })

  it('returns a UUID sessionId on session/new', async () => {
    const { server, sent } = buildServer({
      upstream: happyUpstream(['[DONE]']),
      sessionIds: ['ses-aaa'],
    })
    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: AGENT_METHODS.session_new }))
    expect(findResponse(sent, 'r1').result.sessionId).toBe('ses-aaa')
  })

  it('attaches haystackReferences + haystackDocuments _meta from the final result event', async () => {
    const result = {
      answers: [
        {
          answer: 'final',
          files: [],
          meta: { _references: [{ document_position: 1, document_id: 'd1' }] },
        },
      ],
      documents: [{ id: 'd1', content: 'content', score: 0.9, file: { id: 'f1', name: 'a.pdf' } }],
    }
    const { server, sent } = buildServer({
      upstream: happyUpstream([{ type: 'delta', delta: { text: 'hi' } }, { type: 'result', result }, '[DONE]']),
      sessionIds: ['ses-meta'],
    })

    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-meta', prompt: [{ type: 'text', text: 'q' }] },
      }),
    )

    const updates = sessionUpdates(sent)
    // First update = delta. Second update = empty chunk carrying references _meta.
    expect(updates.length).toBe(2)
    expect(updates[0].update.content.text).toBe('hi')
    expect(updates[1]._meta).toEqual({
      haystackReferences: [{ position: 1, fileId: 'f1', fileName: 'a.pdf', pageNumber: undefined }],
    })

    const promptReply = findResponse(sent, 2)
    expect(promptReply.result.stopReason).toBe('end_turn')
    expect(promptReply.result._meta.haystackReferences).toEqual([
      { position: 1, fileId: 'f1', fileName: 'a.pdf', pageNumber: undefined },
    ])
    expect(promptReply.result._meta.haystackDocuments).toEqual([
      { id: 'd1', content: 'content', score: 0.9, file: { id: 'f1', name: 'a.pdf' } },
    ])
  })

  it('aborts the upstream fetch when session/cancel is received mid-stream', async () => {
    let capturedSignal: AbortSignal | null = null
    let releaseChunk: () => void = () => {}
    const chunkLanded = new Promise<void>((resolve) => {
      releaseChunk = resolve
    })
    const upstream: Upstream = (input, init) => {
      if (input.toString().endsWith('/search_sessions')) {
        return Promise.resolve(jsonResponse(200, { search_session_id: 'sess-cancel' }))
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              capturedSignal = init?.signal ?? null
              const enc = new TextEncoder()
              controller.enqueue(enc.encode('data: {"type":"delta","delta":{"text":"start"}}\n\n'))
              releaseChunk()
              init?.signal?.addEventListener('abort', () => {
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
              })
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    }

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

    await chunkLanded
    await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: AGENT_METHODS.session_cancel, params: { sessionId: 'ses-cancel' } }),
    )
    await promptPromise

    expect(capturedSignal).not.toBeNull()
    expect(capturedSignal!.aborted).toBe(true)
    expect(findResponse(sent, 2).result.stopReason).toBe('cancelled')
  })

  it('keeps the session alive across multiple session/prompt turns on the same socket', async () => {
    // Regression: an earlier revision deleted the session in runPrompt's
    // `finally`, so the second prompt would 404 with `unknown session`.
    let searchCalls = 0
    const queries: string[] = []
    const upstream: Upstream = (input, init) => {
      const url = input.toString()
      if (url.endsWith('/search_sessions')) {
        searchCalls += 1
        return Promise.resolve(jsonResponse(200, { search_session_id: 'sess-multi' }))
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string }
      queries.push(body.query)
      return Promise.resolve(sseResponse([{ type: 'delta', delta: { text: `echo:${body.query}` } }, '[DONE]']))
    }

    const { server, sent } = buildServer({ upstream, sessionIds: ['ses-multi'] })

    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    for (let turn = 0; turn < 3; turn++) {
      await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 10 + turn,
          method: AGENT_METHODS.session_prompt,
          params: { sessionId: 'ses-multi', prompt: [{ type: 'text', text: `q${turn}` }] },
        }),
      )
    }

    // search_sessions is bootstrapped exactly once and reused across all turns.
    expect(searchCalls).toBe(1)
    expect(queries).toEqual(['q0', 'q1', 'q2'])
    for (let turn = 0; turn < 3; turn++) {
      expect(findResponse(sent, 10 + turn).result.stopReason).toBe('end_turn')
    }
  })

  it('resumes the same session after a prior turn was cancelled mid-stream', async () => {
    // Regression: the shared per-session AbortController used to stay
    // aborted, poisoning every follow-up prompt with an AbortError.
    let chatCall = 0
    let releaseFirstChunk: () => void = () => {}
    const firstChunkLanded = new Promise<void>((resolve) => {
      releaseFirstChunk = resolve
    })

    const upstream: Upstream = (input, init) => {
      const url = input.toString()
      if (url.endsWith('/search_sessions')) {
        return Promise.resolve(jsonResponse(200, { search_session_id: 'sess-resume' }))
      }
      chatCall += 1
      if (chatCall === 1) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const enc = new TextEncoder()
                controller.enqueue(enc.encode('data: {"type":"delta","delta":{"text":"part-1"}}\n\n'))
                releaseFirstChunk()
                init?.signal?.addEventListener('abort', () => {
                  controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
                })
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        )
      }
      return Promise.resolve(sseResponse([{ type: 'delta', delta: { text: 'follow-up' } }, '[DONE]']))
    }

    const { server, sent } = buildServer({ upstream, sessionIds: ['ses-resume'] })
    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))

    const firstPrompt = server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-resume', prompt: [{ type: 'text', text: 'first' }] },
      }),
    )
    await firstChunkLanded
    await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: AGENT_METHODS.session_cancel, params: { sessionId: 'ses-resume' } }),
    )
    await firstPrompt
    expect(findResponse(sent, 2).result.stopReason).toBe('cancelled')

    await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-resume', prompt: [{ type: 'text', text: 'second' }] },
      }),
    )
    expect(findResponse(sent, 3).result.stopReason).toBe('end_turn')
    expect(sessionUpdates(sent).some((u) => u.update.content.text === 'follow-up')).toBe(true)
  })

  it('resumes a session on a new server instance via session/load using the persistent map', async () => {
    const persistentMap = new Map<string, string>()
    const upstream: Upstream = (input, init) => {
      const url = input.toString()
      if (url.endsWith('/search_sessions')) {
        return Promise.resolve(jsonResponse(200, { search_session_id: 'sess-persisted' }))
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string; search_session_id: string }
      return Promise.resolve(
        sseResponse([{ type: 'delta', delta: { text: `${body.query}@${body.search_session_id}` } }, '[DONE]']),
      )
    }

    // First socket: create session and run one prompt so the persistent map
    // captures `ses-persist → sess-persisted`.
    const first = buildServer({
      upstream,
      sessionIds: ['ses-persist'],
      persistentSearchSessions: persistentMap,
    })
    await first.server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    await first.server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-persist', prompt: [{ type: 'text', text: 'q1' }] },
      }),
    )
    first.server.dispose()
    expect(persistentMap.get('ses-persist')).toBe('sess-persisted')

    // Second socket: a brand-new server with the same persistent map.
    // session/load restores the session and the next prompt skips the
    // search_sessions bootstrap entirely (reuses `sess-persisted`).
    const second = buildServer({ upstream, persistentSearchSessions: persistentMap })
    await second.server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: AGENT_METHODS.session_load,
        params: { sessionId: 'ses-persist', cwd: '/x', mcpServers: [] },
      }),
    )
    const loadReply = findResponse(second.sent, 10)
    expect(loadReply.error).toBeUndefined()
    expect(loadReply.result).toEqual({})

    await second.server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-persist', prompt: [{ type: 'text', text: 'q2' }] },
      }),
    )
    const promptReply = findResponse(second.sent, 11)
    expect(promptReply.result.stopReason).toBe('end_turn')
    expect(second.captures.some((c) => c.url?.endsWith('/search_sessions'))).toBe(false)
    expect(sessionUpdates(second.sent).some((u) => u.update.content.text === 'q2@sess-persisted')).toBe(true)
  })

  it('returns resourceNotFound when session/load is called with an unknown id', async () => {
    const { server, sent } = buildServer({
      upstream: () => Promise.reject(new Error('upstream should not be called')),
      persistentSearchSessions: new Map<string, string>(),
    })

    await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: AGENT_METHODS.session_load,
        params: { sessionId: 'does-not-exist', cwd: '/x', mcpServers: [] },
      }),
    )

    const reply = findResponse(sent, 1)
    expect(reply.error).toBeDefined()
    expect(reply.error.code).toBe(-32002)
    expect(reply.error.message).toContain('does-not-exist')
  })

  it('evicts the oldest entry once the persistent map exceeds its cap', async () => {
    // Pre-fill the map up to the 1000-entry cap. A test seam keeps the loop
    // cheap and the assertion focused on eviction order rather than absolute
    // size — we just need to prove inserting a new id removes the oldest.
    const cap = 1000
    const persistentMap = new Map<string, string>()
    for (let i = 0; i < cap; i++) {
      persistentMap.set(`stale-${i}`, `search-${i}`)
    }

    const upstream: Upstream = (input) => {
      const url = input.toString()
      if (url.endsWith('/search_sessions')) {
        return Promise.resolve(jsonResponse(200, { search_session_id: 'sess-fresh' }))
      }
      return Promise.resolve(sseResponse([{ type: 'delta', delta: { text: 'hi' } }, '[DONE]']))
    }

    const { server } = buildServer({
      upstream,
      sessionIds: ['ses-fresh'],
      persistentSearchSessions: persistentMap,
    })
    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-fresh', prompt: [{ type: 'text', text: 'go' }] },
      }),
    )

    expect(persistentMap.size).toBe(cap)
    expect(persistentMap.has('stale-0')).toBe(false)
    expect(persistentMap.get('ses-fresh')).toBe('sess-fresh')
  })
})
