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
 *  - HTTP 591 retry with the cold-pipeline backoff path.
 *  - SSE delta translation into `session/update` notifications.
 *  - Authorization header propagation.
 *  - Workspace embedded in the URL.
 *  - Cancellation aborts both the upstream stream and the prompt response.
 */

import type { Settings } from '@/config/settings'
import { AGENT_METHODS, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'bun:test'
import { HaystackAcpServer } from '../acp-server'

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

  it('retries HTTP 591 on the chat-stream call before giving up', async () => {
    let chatAttempts = 0
    const upstream: Upstream = (input) => {
      const url = input.toString()
      if (url.endsWith('/search_sessions')) {
        return Promise.resolve(jsonResponse(200, { search_session_id: 'sess-591' }))
      }
      chatAttempts += 1
      if (chatAttempts < 3) {
        return Promise.resolve(new Response('cold', { status: 591 }))
      }
      return Promise.resolve(sseResponse([{ type: 'delta', delta: { text: 'warmed' } }, '[DONE]']))
    }

    const { server, sent } = buildServer({
      upstream,
      sessionIds: ['ses-591'],
    })

    await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: AGENT_METHODS.session_new }))
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: AGENT_METHODS.session_prompt,
        params: { sessionId: 'ses-591', prompt: [{ type: 'text', text: 'warm up' }] },
      }),
    )

    expect(chatAttempts).toBe(3)
    const updates = sessionUpdates(sent)
    expect(updates.map((u) => u.update.content.text)).toEqual(['warmed'])
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
})
