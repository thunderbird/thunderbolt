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
import { z } from 'zod'
import { extractDocuments, extractReferences, parseHaystackSseStream } from './sse-parser'
import type { HaystackDocumentMeta, HaystackEvent, HaystackReferenceMeta, HaystackSessionContext } from './types'

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

/**
 * HTTP status Deepset returns when a pipeline is waking from idle. The
 * pipeline is cold and will be available shortly — retry with backoff.
 */
const pipelineNotReadyStatus = 591
const maxRetryAttempts = 3
const defaultRetryBaseDelayMs = 1_000

/** Zod schema for the Deepset `search_sessions` response. */
const searchSessionResponseSchema = z.object({
  search_session_id: z.string().min(1),
})

export type HaystackAcpDeps = {
  /** Injected so tests can mock the Deepset upstream. */
  fetchFn?: typeof fetch
  /** UUID generator override for deterministic session ids in tests. */
  generateSessionId?: () => string
  /**
   * Base delay (ms) between 591 retry attempts. Defaults to 1 s; tests pin to
   * 0 so the backoff doesn't add wall-clock seconds.
   */
  retryBaseDelayMs?: number
}

export type HaystackAcpServerOptions = {
  send: Sender
  /** Deepset pipeline UUID — used as `pipeline_id` body when creating a search session. */
  pipelineId: string
  /** Deepset pipeline URL slug — used in the `/pipelines/${pipelineName}/chat-stream` path. */
  pipelineName: string
  settings: Settings
  deps?: HaystackAcpDeps
}

/**
 * Per-connection ACP server. The Elysia ws handler creates one of these on
 * `open`, dispatches each incoming text frame through {@link handleMessage},
 * and disposes via {@link dispose} on close.
 *
 * Sessions live for the entire WebSocket lifetime — they are NOT torn down at
 * the end of a single `session/prompt`. This lets the FE drive a multi-turn
 * chat against the same ACP session id over one socket. Each turn gets its
 * own short-lived AbortController so that `session/cancel` only interrupts
 * the in-flight turn and the session remains usable for the next prompt.
 *
 * Upstream wire (Deepset Cloud):
 *  1. `POST {base}/api/v1/workspaces/{workspace}/search_sessions`
 *     body `{ pipeline_id: <uuid> }` → returns `{ search_session_id }`.
 *     Bootstrapped lazily on the first `session/prompt`, reused thereafter
 *     so multi-turn chat history is preserved server-side.
 *  2. `POST {base}/api/v1/workspaces/{workspace}/pipelines/{pipelineName}/chat-stream`
 *     body `{ query, search_session_id, include_result: true }` with
 *     `Accept: text/event-stream`. SSE response → translated into ACP
 *     `session/update` notifications.
 *
 * Both upstream calls go through {@link fetchWithPipelineRetry} which retries
 * HTTP 591 (cold pipeline) with exponential backoff (1 s → 2 s → 4 s, capped
 * at 3 attempts).
 */
export class HaystackAcpServer {
  private readonly sessions = new Map<string, HaystackSessionContext>()
  private readonly send: Sender
  private readonly pipelineId: string
  private readonly pipelineName: string
  private readonly settings: Settings
  private readonly fetchFn: typeof fetch
  private readonly generateSessionId: () => string
  private readonly retryBaseDelayMs: number

  constructor(opts: HaystackAcpServerOptions) {
    this.send = opts.send
    this.pipelineId = opts.pipelineId
    this.pipelineName = opts.pipelineName
    this.settings = opts.settings
    this.fetchFn = opts.deps?.fetchFn ?? globalThis.fetch
    this.generateSessionId = opts.deps?.generateSessionId ?? (() => crypto.randomUUID())
    this.retryBaseDelayMs = opts.deps?.retryBaseDelayMs ?? defaultRetryBaseDelayMs
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

    if (!('id' in message) || message.id === undefined) {
      await this.handleNotification(message as JsonRpcNotification)
      return
    }
    await this.handleRequest(message as JsonRpcRequest)
  }

  /** Tear down all sessions. Idempotent — `close` may fire twice in edge cases. */
  dispose(): void {
    for (const ctx of this.sessions.values()) {
      ctx.currentTurnAbort?.abort()
      ctx.currentTurnAbort = null
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
    // Abort only the in-flight turn — the session itself stays alive so the
    // FE can immediately follow up with another `session/prompt`.
    ctx.currentTurnAbort?.abort()
  }

  /**
   * MVP capability set: Haystack RAG returns plaintext deltas + a final
   * result payload with citation metadata. We advertise `loadSession: false`
   * because Deepset's `search_session` is server-side state but doesn't
   * expose a "resume by id" surface to us.
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
      pipelineName: this.pipelineName,
      searchSessionId: null,
      currentTurnAbort: null,
    })
    return { sessionId }
  }

  /**
   * Drive a `session/prompt` turn end-to-end:
   *  1. Look up the ACP session (404-ish error if unknown).
   *  2. Bootstrap a Deepset `search_session_id` if we don't already have one
   *     for this ACP session. Reusing the id preserves multi-turn chat
   *     history server-side.
   *  3. Concatenate text content blocks into a single query string.
   *  4. POST to `/pipelines/{pipelineName}/chat-stream` with SSE accept.
   *  5. Stream events; for each `delta` emit `session/update` with an
   *     `agent_message_chunk`. On `result`, attach citation metadata as
   *     `_meta` on a terminal chunk + the prompt response. On `done` or
   *     stream-end, reply with `end_turn`.
   *
   * A fresh AbortController is created for each turn and stored on the
   * session as `currentTurnAbort`. `session/cancel` aborts only the in-flight
   * controller, leaving the session itself intact for follow-up prompts.
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

    // Abort any previously running turn on this session — a reentrant
    // `session/prompt` arriving before the prior turn finished supersedes it.
    ctx.currentTurnAbort?.abort()
    const turnAbort = new AbortController()
    ctx.currentTurnAbort = turnAbort

    const userText = extractUserText(params)

    try {
      if (ctx.searchSessionId === null) {
        ctx.searchSessionId = await this.createSearchSession(ctx, turnAbort.signal)
      }

      const streamResponse = await this.openChatStream(ctx, userText, turnAbort.signal)
      if (!streamResponse.body) {
        this.sendError(req.id, rpcErrors.internalError, 'haystack chat-stream response has no body')
        return
      }

      const { references, documents, stopReason } = await this.streamUpstream(
        ctx,
        streamResponse.body,
        turnAbort.signal,
      )
      const promptResponse: PromptResponse = {
        stopReason,
        ...(references.length > 0 || documents.length > 0
          ? { _meta: { haystackReferences: references, haystackDocuments: documents } }
          : {}),
      }
      this.sendResult(req.id, promptResponse)
    } catch (err) {
      if (isAbortError(err)) {
        this.sendResult(req.id, { stopReason: 'cancelled' } as PromptResponse)
        return
      }
      const message = (err as Error).message ?? 'haystack request failed'
      this.emitAgentTextChunk(ctx, `[haystack error] ${message}`)
      this.sendError(req.id, rpcErrors.internalError, message)
    } finally {
      if (ctx.currentTurnAbort === turnAbort) {
        ctx.currentTurnAbort = null
      }
    }
  }

  /** Bootstrap a Deepset `search_session_id` for this ACP session. */
  private async createSearchSession(ctx: HaystackSessionContext, signal: AbortSignal): Promise<string> {
    const url = `${this.workspaceBaseUrl()}/search_sessions`
    const response = await this.fetchWithPipelineRetry(url, {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify({ pipeline_id: ctx.pipelineId }),
      signal,
    })
    const data = (await response.json()) as unknown
    const parsed = searchSessionResponseSchema.parse(data)
    return parsed.search_session_id
  }

  /** Open the SSE chat stream for a single prompt turn. */
  private openChatStream(ctx: HaystackSessionContext, query: string, signal: AbortSignal): Promise<Response> {
    const url = `${this.workspaceBaseUrl()}/pipelines/${ctx.pipelineName}/chat-stream`
    return this.fetchWithPipelineRetry(url, {
      method: 'POST',
      headers: { ...this.jsonHeaders(), accept: 'text/event-stream' },
      body: JSON.stringify({
        query,
        search_session_id: ctx.searchSessionId,
        include_result: true,
      }),
      signal,
    })
  }

  /**
   * Retry a fetch on 591 (Deepset cold-pipeline) with exponential backoff.
   * Bails on the first non-591 non-OK response with a structured error.
   */
  private async fetchWithPipelineRetry(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < maxRetryAttempts; attempt++) {
      const response = await this.fetchFn(url, init)
      if (response.ok) {
        return response
      }
      if (response.status === pipelineNotReadyStatus && attempt < maxRetryAttempts - 1) {
        await this.abortableSleep(this.retryBaseDelayMs * Math.pow(2, attempt), init.signal ?? null)
        continue
      }
      const body = await response.text().catch(() => '')
      throw new Error(
        `haystack upstream ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`,
      )
    }
    throw new Error('haystack upstream: 591 retries exhausted')
  }

  private abortableSleep(ms: number, signal: AbortSignal | null): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve()
    }
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal))
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortReason(signal!))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Translate Haystack SSE events into ACP `session/update` notifications
   * and return references/documents extracted from the final `result` event.
   *
   *  - `delta` → `session/update` with `agent_message_chunk` text content.
   *  - `result`→ extract refs/docs; if refs are non-empty, also emit a
   *    terminal empty chunk carrying `_meta.haystackReferences` so the FE
   *    can render citations as soon as they land.
   *  - `error` → throw; caller converts to JSON-RPC error.
   *  - `done`  → terminate the stream loop.
   *  - AbortError on the fetch → propagated up to caller (becomes `cancelled`).
   */
  private async streamUpstream(
    ctx: HaystackSessionContext,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<{
    references: HaystackReferenceMeta[]
    documents: HaystackDocumentMeta[]
    stopReason: PromptResponse['stopReason']
  }> {
    let references: HaystackReferenceMeta[] = []
    let documents: HaystackDocumentMeta[] = []

    for await (const event of parseHaystackSseStream(body)) {
      if (signal.aborted) {
        return { references, documents, stopReason: 'cancelled' }
      }
      const terminal = this.translateEvent(ctx, event, (refs, docs) => {
        references = refs
        documents = docs
      })
      if (terminal !== null) {
        return { references, documents, stopReason: terminal }
      }
    }
    return { references, documents, stopReason: 'end_turn' }
  }

  private translateEvent(
    ctx: HaystackSessionContext,
    event: HaystackEvent,
    captureResult: (refs: HaystackReferenceMeta[], docs: HaystackDocumentMeta[]) => void,
  ): PromptResponse['stopReason'] | null {
    if (event.type === 'delta') {
      this.emitAgentTextChunk(ctx, event.text)
      return null
    }
    if (event.type === 'result') {
      const refs = extractReferences(event.result)
      const docs = extractDocuments(event.result)
      captureResult(refs, docs)
      if (refs.length > 0) {
        this.emitAgentTextChunk(ctx, '', { haystackReferences: refs })
      }
      return null
    }
    if (event.type === 'done') {
      return 'end_turn'
    }
    // event.type === 'error'
    throw new Error(event.error)
  }

  private emitAgentTextChunk(ctx: HaystackSessionContext, text: string, meta?: Record<string, unknown>): void {
    const notification: SessionNotification = {
      sessionId: ctx.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
      ...(meta ? { _meta: meta } : {}),
    }
    this.sendNotification('session/update', notification)
  }

  private workspaceBaseUrl(): string {
    const base = this.settings.haystackBaseUrl.replace(/\/$/, '')
    return `${base}/api/v1/workspaces/${this.settings.haystackWorkspace}`
  }

  private jsonHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(this.settings.haystackApiKey ? { authorization: `Bearer ${this.settings.haystackApiKey}` } : {}),
    }
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
 * ignore non-text content (image/audio/resource).
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

const isAbortError = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) {
    return false
  }
  const name = (err as { name?: string }).name
  return name === 'AbortError'
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' })
