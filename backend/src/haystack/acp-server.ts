/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import {
  AGENT_METHODS,
  PROTOCOL_VERSION,
  type CancelNotification,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { parseHaystackSseStream } from './sse-parser'
import type { HaystackEvent, HaystackSessionContext } from './types'

/**
 * Minimal JSON-RPC 2.0 envelope. We don't pull the SDK's `AnyMessage` type
 * because our wire is a single WebSocket whose payload is text. Validating
 * `jsonrpc: "2.0"` + `method` + `id` is enough — the rest is method-specific
 * and dispatched below.
 */
type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: string | number | null
  method: string
  params?: unknown
}

type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

type JsonRpcSuccess = {
  jsonrpc: '2.0'
  id: string | number | null
  result: unknown
}

type JsonRpcError = {
  jsonrpc: '2.0'
  id: string | number | null
  error: { code: number; message: string; data?: unknown }
}

type Sender = (payload: string) => void

/** JSON-RPC error codes used by the adapter. */
const rpcErrors = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  internalError: -32603,
} as const

export type HaystackAcpDeps = {
  /** Injected so tests can mock the Haystack `/runs` endpoint. */
  fetchFn?: typeof fetch
  /** UUID generator override for deterministic session ids in tests. */
  generateSessionId?: () => string
}

/**
 * Per-connection ACP server. The Elysia ws handler creates one of these on
 * `open`, dispatches each incoming text frame through {@link handleMessage},
 * and disposes via {@link dispose} on close.
 *
 * Design notes:
 *  - State is keyed by ACP `sessionId`. A single WebSocket may host multiple
 *    sessions, but in MVP the FE opens one connection per chat thread so we
 *    expect 1:1. The map keeps the invariant cheap to verify in tests.
 *  - Each session owns an `AbortController` so `session/cancel` aborts the
 *    in-flight upstream stream without disturbing the other sessions on the
 *    same socket.
 *  - The class is deliberately not exported as a singleton — Elysia hands us
 *    a fresh `data` object per connection, so we instantiate per `open`.
 */
export class HaystackAcpServer {
  private readonly sessions = new Map<string, HaystackSessionContext>()
  private readonly send: Sender
  private readonly pipelineId: string
  private readonly settings: Settings
  private readonly fetchFn: typeof fetch
  private readonly generateSessionId: () => string

  constructor(opts: { send: Sender; pipelineId: string; settings: Settings; deps?: HaystackAcpDeps }) {
    this.send = opts.send
    this.pipelineId = opts.pipelineId
    this.settings = opts.settings
    this.fetchFn = opts.deps?.fetchFn ?? globalThis.fetch
    this.generateSessionId = opts.deps?.generateSessionId ?? (() => crypto.randomUUID())
  }

  /** Handle a single inbound WebSocket text frame. */
  async handleMessage(raw: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      this.sendError(null, rpcErrors.parseError, 'invalid JSON')
      return
    }
    if (!isJsonRpcMessage(message)) {
      this.sendError(null, rpcErrors.invalidRequest, 'not a JSON-RPC 2.0 envelope')
      return
    }

    // Notifications carry no `id`. Cancellation is the only one we observe.
    if (!('id' in message) || message.id === undefined) {
      await this.handleNotification(message as JsonRpcNotification)
      return
    }
    await this.handleRequest(message as JsonRpcRequest)
  }

  /** Tear down all sessions. Idempotent — `close` may fire twice in edge cases. */
  dispose(): void {
    for (const ctx of this.sessions.values()) {
      ctx.abort.abort()
    }
    this.sessions.clear()
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    switch (req.method) {
      case AGENT_METHODS.initialize:
        this.sendResult(req.id, this.buildInitializeResponse())
        return
      case AGENT_METHODS.session_new:
        this.sendResult(req.id, this.buildNewSessionResponse())
        return
      case AGENT_METHODS.session_prompt:
        await this.runPrompt(req)
        return
      default:
        this.sendError(req.id, rpcErrors.methodNotFound, `method not supported: ${req.method}`)
    }
  }

  private async handleNotification(note: JsonRpcNotification): Promise<void> {
    if (note.method !== AGENT_METHODS.session_cancel) {
      // Unknown notifications are dropped silently per JSON-RPC 2.0.
      return
    }
    const params = note.params as CancelNotification | undefined
    if (!params || typeof params.sessionId !== 'string') {
      return
    }
    const ctx = this.sessions.get(params.sessionId)
    if (!ctx) {
      return
    }
    ctx.abort.abort()
  }

  /**
   * MVP capability set: Haystack RAG returns plaintext deltas. We deliberately
   * advertise `loadSession: false` because Haystack's `/runs` is stateless per
   * call — there is no server-side conversation to resume. Image / audio /
   * embedded context are disabled until the upstream supports them.
   */
  private buildInitializeResponse(): InitializeResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'Thunderbolt Haystack Adapter', version: '1.0.0' },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
      },
    }
  }

  private buildNewSessionResponse(): NewSessionResponse {
    const sessionId = this.generateSessionId()
    this.sessions.set(sessionId, {
      sessionId,
      pipelineId: this.pipelineId,
      abort: new AbortController(),
    })
    return { sessionId }
  }

  /**
   * Drive a `session/prompt` turn end-to-end:
   *  1. Look up the ACP session (404-ish error if unknown).
   *  2. Concatenate text content blocks into a single Haystack query string.
   *  3. POST to `${HAYSTACK_BASE_URL}/runs` with SSE accept and pipeline body.
   *  4. Stream events; for each `delta` emit `session/update` with an
   *     `agent_message_chunk` of type text. On `done`, reply with the
   *     `session/prompt` result; on `error`, reply with `refusal` after
   *     surfacing the error as a final chunk.
   *
   * The per-session AbortController is wired into the fetch — `session/cancel`
   * trips it, which both stops upstream and resolves the prompt with
   * `cancelled`. We treat that as the spec-mandated "respond with cancelled
   * stop reason" path.
   */
  private async runPrompt(req: JsonRpcRequest): Promise<void> {
    const params = req.params as PromptRequest | undefined
    if (!params || typeof params.sessionId !== 'string') {
      this.sendError(req.id, rpcErrors.invalidRequest, 'session/prompt requires sessionId')
      return
    }
    const ctx = this.sessions.get(params.sessionId)
    if (!ctx) {
      this.sendError(req.id, rpcErrors.invalidRequest, `unknown session: ${params.sessionId}`)
      return
    }

    const userText = extractUserText(params)
    const upstreamUrl = `${this.settings.haystackBaseUrl.replace(/\/$/, '')}/runs`

    const startResponse = await this.fetchFn(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(this.settings.haystackApiKey ? { authorization: `Bearer ${this.settings.haystackApiKey}` } : {}),
      },
      body: JSON.stringify({
        pipeline_id: ctx.pipelineId,
        query: userText,
        stream: true,
      }),
      signal: ctx.abort.signal,
    })

    if (!startResponse.ok || !startResponse.body) {
      const detail = await safeReadText(startResponse)
      this.sendError(req.id, rpcErrors.internalError, `upstream ${startResponse.status}: ${detail.slice(0, 200)}`)
      return
    }

    const stopReason = await this.streamUpstream(ctx, startResponse.body)
    const promptResponse: PromptResponse = { stopReason }
    this.sendResult(req.id, promptResponse)
  }

  /**
   * Translate Haystack SSE events into ACP `session/update` notifications and
   * return the final stop reason. Translation table:
   *  - `delta` → `session/update` with `update.sessionUpdate = "agent_message_chunk"`,
   *    `update.content = { type: "text", text }`.
   *  - `done`  → terminate; stop reason from event payload (default `end_turn`).
   *  - `error` → emit a final text chunk carrying the error message, return
   *    `refusal`. The upstream message is surfaced verbatim so the FE can
   *    show actionable detail.
   *  - AbortError on the fetch → stop reason `cancelled`.
   */
  private async streamUpstream(
    ctx: HaystackSessionContext,
    body: ReadableStream<Uint8Array>,
  ): Promise<PromptResponse['stopReason']> {
    try {
      for await (const event of parseHaystackSseStream(body)) {
        const terminal = this.translateEvent(ctx, event)
        if (terminal !== null) {
          return terminal
        }
      }
      return 'end_turn'
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        return 'cancelled'
      }
      // Surface parser/schema failures as a refusal chunk so the FE sees why.
      this.emitAgentTextChunk(ctx, `[haystack error] ${(err as Error).message}`)
      return 'refusal'
    } finally {
      this.sessions.delete(ctx.sessionId)
    }
  }

  /** Per-event branch. Returns the terminal stop reason or null to continue. */
  private translateEvent(ctx: HaystackSessionContext, event: HaystackEvent): PromptResponse['stopReason'] | null {
    if (event.type === 'delta') {
      this.emitAgentTextChunk(ctx, event.text)
      return null
    }
    if (event.type === 'done') {
      return event.stopReason ?? 'end_turn'
    }
    // event.type === 'error'
    this.emitAgentTextChunk(ctx, `[haystack error] ${event.error}`)
    return 'refusal'
  }

  private emitAgentTextChunk(ctx: HaystackSessionContext, text: string): void {
    const notification: SessionNotification = {
      sessionId: ctx.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    }
    this.sendNotification('session/update', notification)
  }

  private sendResult(id: JsonRpcRequest['id'], result: unknown): void {
    const payload: JsonRpcSuccess = { jsonrpc: '2.0', id, result }
    this.send(JSON.stringify(payload))
  }

  private sendError(id: JsonRpcRequest['id'], code: number, message: string): void {
    const payload: JsonRpcError = { jsonrpc: '2.0', id, error: { code, message } }
    this.send(JSON.stringify(payload))
  }

  private sendNotification(method: string, params: unknown): void {
    const payload: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.send(JSON.stringify(payload))
  }
}

const isJsonRpcMessage = (value: unknown): value is JsonRpcRequest | JsonRpcNotification => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const v = value as { jsonrpc?: unknown; method?: unknown }
  return v.jsonrpc === '2.0' && typeof v.method === 'string'
}

/**
 * Pull plain text out of an ACP `PromptRequest`. ACP allows mixed content
 * blocks; Haystack accepts a single query string, so we join text blocks and
 * ignore non-text content (image/audio/resource). Image support is wired off
 * via `promptCapabilities.image: false` so we never receive those here.
 */
const extractUserText = (params: PromptRequest): string => {
  const blocks = params.prompt ?? []
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      texts.push(block.text)
    }
  }
  return texts.join('\n')
}

const safeReadText = async (response: Response): Promise<string> => {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
