/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import {
  AGENT_METHODS,
  PROTOCOL_VERSION,
  type CancelNotification,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
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

/**
 * JSON-RPC error codes used by the adapter. `resourceNotFound` matches the
 * ACP SDK's {@link RequestError.resourceNotFound} so clients that special-case
 * the SDK error code keep working when we surface it from
 * {@link runLoadSession}.
 */
const rpcErrors = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  internalError: -32603,
  resourceNotFound: -32002,
} as const

/**
 * HTTP statuses worth retrying for a cold/idling Deepset pipeline. Deepset
 * Cloud scales idle pipelines to zero replicas and, while a replica wakes,
 * answers with `503` and the body
 * `{"errors":["The pipeline '<name>' is temporarily unavailable. Try again
 * in a few moments."]}` (verified against the live API). `502` is included
 * because the load balancer can briefly fail to route to a just-spawned
 * replica during the same wake. The legacy `591` from reference PR #531 was a
 * fiction — Deepset never sends it — so it is dropped here; retrying on status
 * alone masked genuine outages. Retry is additionally gated on the response
 * BODY (see {@link isTransientPipelineWake}) so a real 5xx fails fast.
 */
const retryablePipelineStatuses = new Set([502, 503])
const maxRetryAttempts = 5
const defaultRetryBaseDelayMs = 2_000
/** Per-step backoff ceiling so a single wait never blows the total budget. */
const maxRetryStepDelayMs = 16_000

/**
 * Decide whether a non-OK Deepset response is a transient cold-pipeline wake
 * (retry) versus a genuine error (fail fast). Gating on the body — not the
 * status alone — is the whole point of the fix: every wake carries the
 * "temporarily unavailable" marker, either as plain text or inside Deepset's
 * `{ errors: [...] }` envelope. Anything else (empty body, different message,
 * real outage) returns false and the caller throws immediately.
 */
const isTransientPipelineWake = (status: number, bodyText: string): boolean => {
  if (!retryablePipelineStatuses.has(status)) {
    return false
  }
  return /temporarily unavailable/i.test(bodyText)
}

/**
 * Soft cap on how many `(acpSessionId → deepsetSearchSessionId)` mappings the
 * server keeps in memory across WebSocket lifetimes. When exceeded, the
 * oldest insertion-order entry is evicted (Map iteration is insertion-order,
 * so `keys().next()` is the LRU-ish candidate). 1000 mirrors a reasonable
 * upper bound for active per-process sessions in a single backend replica.
 */
const persistentSearchSessionsCap = 1_000

/**
 * Module-level mapping of ACP session id → Deepset `search_session_id`. This
 * survives individual WebSocket connections so `session/load` can restore the
 * upstream history after a transport-level reconnect. Tests get a fresh map
 * via `HaystackAcpDeps.persistentSearchSessions` (DI).
 */
const defaultPersistentSearchSessions = new Map<string, string>()

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
   * Base delay (ms) for the cold-pipeline retry backoff. Defaults to 2 s;
   * tests pin to 0 so the backoff doesn't add wall-clock seconds.
   */
  retryBaseDelayMs?: number
  /**
   * Map backing `session/load` resume. Defaults to a module-level instance so
   * production resume works across WebSocket reconnects on the same process;
   * tests inject a fresh map for isolation.
   */
  persistentSearchSessions?: Map<string, string>
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
 * a cold/idling pipeline — a `502`/`503` whose body carries Deepset's
 * "temporarily unavailable" marker — with capped exponential backoff
 * (2 s → 4 s → 8 s → 16 s → 16 s, 5 attempts). Any other 5xx fails fast.
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
  private readonly persistentSearchSessions: Map<string, string>

  constructor(opts: HaystackAcpServerOptions) {
    this.send = opts.send
    this.pipelineId = opts.pipelineId
    this.pipelineName = opts.pipelineName
    this.settings = opts.settings
    this.fetchFn = opts.deps?.fetchFn ?? globalThis.fetch
    this.generateSessionId = opts.deps?.generateSessionId ?? (() => crypto.randomUUID())
    this.retryBaseDelayMs = opts.deps?.retryBaseDelayMs ?? defaultRetryBaseDelayMs
    this.persistentSearchSessions = opts.deps?.persistentSearchSessions ?? defaultPersistentSearchSessions
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
      case AGENT_METHODS.session_load:
        this.runLoadSession(req)
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
   * Capability set: Haystack RAG returns plaintext deltas + a final result
   * payload with citation metadata, and we support `session/load` so a client
   * can resume a session after a WebSocket reconnect. Resume is backed by a
   * module-level `persistentSearchSessions` map that retains the Deepset
   * `search_session_id` for each ACP session id across socket lifetimes.
   */
  private buildInitializeResponse(): InitializeResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'Thunderbolt Haystack Adapter', version: '1.0.0' },
      agentCapabilities: {
        loadSession: true,
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
    this.registerSession(sessionId, null)
    return { sessionId }
  }

  /**
   * Restore a previously created session in this server instance from the
   * module-level persistent map. The map is populated lazily — only sessions
   * that have already bootstrapped a Deepset `search_session_id` (i.e. that
   * received at least one prompt) are resumable. Unknown ids surface the ACP
   * standard `resourceNotFound` (-32002) error so clients can fall back to
   * `session/new`.
   */
  private runLoadSession(req: JsonRpcRequest): void {
    const params = req.params as LoadSessionRequest | undefined
    if (!params || typeof params.sessionId !== 'string') {
      this.sendError(req.id, rpcErrors.invalidRequest, 'session/load requires sessionId')
      return
    }
    const searchSessionId = this.persistentSearchSessions.get(params.sessionId)
    if (!searchSessionId) {
      this.sendError(req.id, rpcErrors.resourceNotFound, `unknown session: ${params.sessionId}`)
      return
    }
    this.registerSession(params.sessionId, searchSessionId)
    const response: LoadSessionResponse = {}
    this.sendResult(req.id, response)
  }

  /** Install a fresh idle session context into the per-connection map. */
  private registerSession(sessionId: string, searchSessionId: string | null): void {
    this.sessions.set(sessionId, {
      sessionId,
      pipelineId: this.pipelineId,
      pipelineName: this.pipelineName,
      searchSessionId,
      currentTurnAbort: null,
    })
  }

  /**
   * Record `(acpSessionId → deepsetSearchSessionId)` in the persistent map so
   * future `session/load` requests on a different WebSocket can resume this
   * session. Evicts the oldest entry once the soft cap is reached.
   */
  private rememberSearchSession(acpSessionId: string, searchSessionId: string): void {
    if (this.persistentSearchSessions.size >= persistentSearchSessionsCap) {
      const oldest = this.persistentSearchSessions.keys().next().value
      if (oldest !== undefined) {
        this.persistentSearchSessions.delete(oldest)
      }
    }
    this.persistentSearchSessions.set(acpSessionId, searchSessionId)
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
        this.rememberSearchSession(ctx.sessionId, ctx.searchSessionId)
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
   * Retry a fetch while a cold Deepset pipeline wakes from idle, then surface
   * a structured error on anything else.
   *
   * The body is read exactly once per non-OK response because the retry
   * decision depends on it (see {@link isTransientPipelineWake}) — status
   * alone is insufficient. Reading it to completion also drains and releases
   * the underlying socket, so a discarded retry response leaks nothing. When
   * we DON'T retry, the already-read text is reused in the thrown error.
   */
  private async fetchWithPipelineRetry(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < maxRetryAttempts; attempt++) {
      const response = await this.fetchFn(url, init)
      if (response.ok) {
        return response
      }
      const bodyText = await response.text().catch(() => '')
      const isLastAttempt = attempt === maxRetryAttempts - 1
      if (!isLastAttempt && isTransientPipelineWake(response.status, bodyText)) {
        await this.abortableSleep(this.backoffDelayMs(attempt, response), init.signal ?? null)
        continue
      }
      throw new Error(
        `haystack upstream ${response.status} ${response.statusText}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`,
      )
    }
    throw new Error('haystack upstream: cold-pipeline retries exhausted')
  }

  /**
   * Capped exponential backoff for attempt `n` (0-based). Honors a numeric
   * `Retry-After` header when Deepset sends one (clamped to the per-step
   * cap), otherwise `base * 2^n`. Both are clamped so a single wait can't
   * exceed {@link maxRetryStepDelayMs}.
   */
  private backoffDelayMs(attempt: number, response: Response): number {
    const exponential = this.retryBaseDelayMs * 2 ** attempt
    const retryAfterSeconds = Number(response.headers.get('retry-after'))
    const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 0
    return Math.min(Math.max(exponential, retryAfterMs), maxRetryStepDelayMs)
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
