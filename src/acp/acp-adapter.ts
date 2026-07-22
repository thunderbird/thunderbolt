/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Generic ACP adapter. Used for both `remote-acp` and `managed-acp` agents —
 * the wire is identical, only the URL provenance differs.
 *
 * One adapter owns ONE transport + ONE `ClientSideConnection` + ONE
 * `initialize`, and MULTIPLEXES many per-thread ACP sessions over it. This is
 * what lets a single agent connection be reused across every chat thread that
 * targets that agent (see `src/acp/adapter-cache.ts`).
 *
 * Lifecycle:
 *   1. `connectAcpAdapter(agent, deps)` opens the transport, builds a
 *      `ClientSideConnection`, and sends `initialize`. The handshake is raced
 *      against the transport's terminal-close signal and a bounded timeout — a
 *      permanently-failed or silent transport rejects loudly instead of hanging
 *      the chat's fetch forever. NO per-thread session is resolved here.
 *   2. Each `adapter.fetch(init, ctx)` resolves the calling thread's ACP
 *      session lazily and once. With a stored `ctx.acpSessionId` it tries, by
 *      advertised capability, `session/resume` → `session/load` (each degrading
 *      to the next on a runtime rejection); otherwise — or if both fall through
 *      — it mints `session/new`. A fresh session's id is persisted via
 *      `ctx.onAcpSessionId` on the FIRST real send (not at resolution), and for
 *      a non-resumable agent that first send also seeds the prior transcript as
 *      context so the fresh agent isn't blind. The resolved id is cached per
 *      thread so repeated sends never re-resolve. All calls go through the same
 *      handshake guard as `initialize`.
 *   3. `session/update` notifications are routed by their `sessionId` to the
 *      owning thread's translator via a `Map<sessionId, sink>`, so two threads
 *      streaming at once never bleed into each other.
 *   4. `disconnect()` closes the transport (which aborts the SDK connection via
 *      its internal AbortSignal). Called only on real teardown — agent delete,
 *      agent config edit, or sign-out.
 */

import type {
  Agent as AcpSdkAgent,
  ClientSideConnection,
  Client,
  ContentBlock,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import { ClientSideConnection as ClientSideConnectionImpl } from '@agentclientprotocol/sdk'
import type { Agent, AgentAdapter, AgentAdapterContext, AgentCapabilities, EnsureSessionContext } from '@/types/acp'
import type { ThunderboltUIMessage } from '@/types'
import { blobToBase64, getAttachments, type HydratedAttachment } from '@/lib/attachments'
import { renderMessageQuotesAsText } from '@/lib/quotes'
import { getTransformer } from '@/files/transformers'
import { getAttachment } from '@/lib/file-blob-storage'
import { openTransport } from './transports'
import type { AcpTransport } from './types'
import { createTranslatorStream, toAcpCommands, type AcpCommand } from './translators/acp-to-ai-sdk'
import type { WebSocketFactory } from './transports/websocket'

const protocolVersion = 1
/** Connect-phase budget. Generous on purpose: a cold-starting upstream (e.g. a
 *  Railway container) may take a while to answer `initialize`. This bounds ONLY
 *  the handshake — never the prompt/streaming phase, which is legitimately long
 *  and is torn down via the transport instead. */
const defaultHandshakeTimeoutMs = 30_000
/** ACP requires `cwd` on session/new + session/load. Browser clients cannot
 *  know a remote agent's absolute path, so use its launch-relative directory. */
const sessionCwd = '.'
const clientName = 'thunderbolt'
const clientVersion = '0.2.0'

/** Callback type the adapter invokes when the agent requests permission. The
 *  chat layer resolves it from a UI dialog; in tests it can be stubbed to
 *  return a fixed response synchronously. */
export type RequestPermissionFn = (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>

/** Default fallback when no `requestPermission` callback is wired — preserves
 *  the prior stub behavior so existing tests and built-in flows still work. */
const cancelledPermission: RequestPermissionFn = async () => ({
  outcome: { outcome: 'cancelled' },
})

/** The minimum Client implementation we register with `ClientSideConnection`.
 *  Session updates and permission prompts both carry an ACP `sessionId`, so we
 *  route each to the owning thread's per-session handler. The handlers live in
 *  caller-owned maps that the adapter mutates as threads start/stop prompting. */
const createClientHandler = (
  onSessionUpdate: (notification: SessionNotification) => void,
  onRequestPermission: RequestPermissionFn,
): Client => ({
  sessionUpdate: async (params) => {
    onSessionUpdate(params)
  },
  requestPermission: onRequestPermission,
})

/** Map the agent's `initialize` response to the flat {@link AgentCapabilities}
 *  shape the UI cares about. Shared with the settings connection probe
 *  (`./connection-test`) so both paths report capabilities identically. */
export const adaptCapabilities = (response: InitializeResponse): AgentCapabilities => {
  const caps = response.agentCapabilities
  return {
    loadSession: caps?.loadSession ?? false,
    // `sessionCapabilities.resume` is an empty `SessionResumeCapabilities`
    // object (`{}`) when supported, `null`/absent otherwise — so presence, not
    // truthiness, is the signal.
    resume: caps?.sessionCapabilities?.resume != null,
    promptCapabilities: {
      image: caps?.promptCapabilities?.image ?? false,
      audio: caps?.promptCapabilities?.audio ?? false,
      embeddedContext: caps?.promptCapabilities?.embeddedContext ?? false,
    },
  }
}

/** Parse the AI SDK request body `{ messages: ThunderboltUIMessage[], id }`. */
const parseRequestMessages = (init: RequestInit): ThunderboltUIMessage[] => {
  if (typeof init.body !== 'string') {
    throw new Error('ACP adapter expects string body on init')
  }
  return (JSON.parse(init.body) as { messages: ThunderboltUIMessage[] }).messages
}

/** Concatenate a UI message's text parts. Non-text parts are dropped — the MVP
 *  `promptCapabilities` are all false, so images/files/tool parts never travel. */
const messageText = (message: ThunderboltUIMessage): string =>
  message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')

/**
 * Build the ACP prompt content blocks from the AI SDK request body. The
 * built-in transport posts `{ messages: ThunderboltUIMessage[], id }`; we
 * forward the last user message's text parts as a `text` block.
 *
 * An ACP agent is itself a harness (it does its own file reading/parsing), so
 * the right default is native bytes: when the agent advertises `embeddedContext`
 * each attachment is hydrated from IndexedDB and sent as an embedded `resource`
 * block (base64) — the backend forwards these to the pipeline via
 * `temporary_files`.
 *
 * Without `embeddedContext` (the ACP baseline — only `Text`/`ResourceLink` are
 * guaranteed) the agent can't take embedded bytes, so rather than silently
 * dropping the file we degrade: a text-extractable file (PDF/docx) is sent as
 * an extracted `text` block, and anything else gets a visible "could not be
 * delivered" note in the prompt. This is graceful degradation, NOT the
 * remediation chain — we never rasterize for ACP (a harness wants the real
 * bytes, not our lossy page images).
 */
/** Injectable file deps for {@link buildPromptBlocks} — overridden in tests to avoid IndexedDB/pdfjs. */
export type PromptBlockDeps = {
  getTransformer: typeof getTransformer
  getAttachment: typeof getAttachment
}

const defaultPromptBlockDeps: PromptBlockDeps = { getTransformer, getAttachment }

export const buildPromptBlocks = async (
  init: RequestInit,
  skillInstructions: string[] | undefined,
  embeddedContext: boolean,
  deps: PromptBlockDeps = defaultPromptBlockDeps,
  priorTranscript?: string,
): Promise<ContentBlock[]> => {
  const lastUser = [...parseRequestMessages(init)].reverse().find((m) => m.role === 'user')
  if (!lastUser) {
    throw new Error('ACP adapter: no user message in request body')
  }
  const replyText = messageText(lastUser)
  // Quotes flatten to a leading Markdown blockquote — ACP builds a plain-text
  // prompt, so unlike the AI SDK path we fold them in here rather than passing a
  // structured data-quote part through hydrateQuotesAsText. Ordered ahead of the
  // reply, mirroring the composer (quote chip above the typed text).
  const quotesText = renderMessageQuotesAsText(lastUser)
  const userText = [quotesText, replyText].filter(Boolean).join('\n\n')
  // Skill instructions + (fallback) prior transcript ride the text block (ACP
  // has no system channel) — see composeAcpPrompt.
  const text = composeAcpPrompt(skillInstructions, userText, priorTranscript)

  const attachments = getAttachments(lastUser)
  if (attachments.length === 0) {
    return [{ type: 'text', text }]
  }

  if (embeddedContext) {
    // Native-first: send raw bytes as embedded resources. But remediation may have
    // set deliverAs: 'text' on an attachment (the model couldn't read the native
    // form) — honor that by sending extracted text instead. We never rasterize for
    // ACP (deliverAs: 'images'), so that case also falls back to text extraction.
    // Files missing from IndexedDB get a visible note rather than vanishing.
    const resolved = await Promise.all(attachments.map((attachment) => resolveEmbeddedDelivery(attachment, deps)))
    const blocks = resolved.flatMap((r): ContentBlock[] => {
      if (r.kind === 'resource') {
        return [
          {
            type: 'resource',
            resource: {
              // The backend derives the filename from the URI's last path segment.
              uri: `attachment://${r.attachment.localFileId}/${r.attachment.filename}`,
              mimeType: r.attachment.mimeType,
              blob: r.attachment.base64,
            },
          },
        ]
      }
      return r.kind === 'text' ? [{ type: 'text', text: r.text }] : []
    })
    const undeliverable = resolved.flatMap((r) => (r.kind === 'undeliverable' ? [r.filename] : []))
    return [{ type: 'text', text: text + undeliverableNote(undeliverable) }, ...blocks]
  }

  // No embedded context: deliver text-extractable files as text blocks; flag the rest.
  const resolved = await Promise.all(attachments.map((attachment) => resolveTextDelivery(attachment, deps)))
  const textBlocks = resolved.flatMap((r) => (r.kind === 'text' ? [{ type: 'text' as const, text: r.text }] : []))
  const undeliverable = resolved.flatMap((r) => (r.kind === 'undeliverable' ? [r.filename] : []))
  return [{ type: 'text', text: text + undeliverableNote(undeliverable) }, ...textBlocks]
}

/** A trailing prompt note listing files that couldn't be delivered, or '' when none. */
const undeliverableNote = (filenames: string[]): string =>
  filenames.length > 0
    ? `\n\n${filenames.map((name) => `[Attachment "${name}" could not be delivered to this agent]`).join('\n')}`
    : ''

/**
 * Resolve one attachment for the embedded-context path: native bytes as a
 * `resource` by default, extracted text when remediation set `deliverAs` away
 * from native (text/images — ACP never rasterizes, so images degrades to text),
 * or `undeliverable` when the file is missing from IndexedDB or has no text layer
 * to fall back to.
 */
const resolveEmbeddedDelivery = async (
  attachment: ReturnType<typeof getAttachments>[number],
  deps: PromptBlockDeps,
): Promise<
  | { kind: 'resource'; attachment: HydratedAttachment }
  | { kind: 'text'; text: string }
  | { kind: 'undeliverable'; filename: string }
> => {
  if (attachment.deliverAs === undefined) {
    const file = await deps.getAttachment(attachment.localFileId)
    if (!file) {
      return { kind: 'undeliverable', filename: attachment.filename }
    }
    return { kind: 'resource', attachment: { ...attachment, base64: await blobToBase64(file.blob) } }
  }
  return resolveTextDelivery(attachment, deps)
}

/** Resolve one attachment to an extracted-text block, or mark it undeliverable (no text transformer). */
const resolveTextDelivery = async (
  attachment: ReturnType<typeof getAttachments>[number],
  deps: PromptBlockDeps,
): Promise<{ kind: 'text'; text: string } | { kind: 'undeliverable'; filename: string }> => {
  const transformer = await deps.getTransformer(attachment.mimeType, 'text')
  const file = transformer ? await deps.getAttachment(attachment.localFileId) : null
  if (transformer && file) {
    const output = await transformer(file)
    if ('text' in output) {
      return { kind: 'text', text: `[Attachment: ${attachment.filename}]\n\n${output.text}` }
    }
  }
  return { kind: 'undeliverable', filename: attachment.filename }
}

/** Render the conversation *before* the trailing user turn as a plain-text
 *  context block (mirroring the built-in adapter's transcript shape). Used ONLY
 *  on a fallback `session/new` for an existing thread — i.e. an agent that
 *  advertises neither `resume` nor `loadSession`, whose fresh session would
 *  otherwise start blind. This restores conversation CONTEXT only (what was
 *  said), NOT execution state (tool calls/results, file edits, failed attempts,
 *  compaction summaries) — that is recovered solely for our own agent via
 *  `resume`. No prior text turns → `undefined` (nothing to seed). */
const extractPriorTranscript = (init: RequestInit): string | undefined => {
  const messages = parseRequestMessages(init)
  const lastUserIndex = messages.findLastIndex((m) => m.role === 'user')
  const transcript = messages
    .slice(0, Math.max(lastUserIndex, 0))
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, text: messageText(m) }))
    .filter((turn) => turn.text.length > 0)
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join('\n\n')
  return transcript.length > 0 ? transcript : undefined
}

/** Fold resolved user-skill instructions + (fallback) prior transcript into the
 *  single prompt-text channel ACP gives us. Order: skill instructions first
 *  (behavioral, system-like), the prior-conversation context block next, the
 *  live user text last — mirroring how the built-in pipeline layers system →
 *  history → prompt. Absent blocks are omitted; with none, the user text is
 *  sent unchanged. */
const composeAcpPrompt = (
  skillInstructions: string[] | undefined,
  userText: string,
  priorTranscript?: string,
): string =>
  [
    skillInstructions && skillInstructions.length > 0 ? skillInstructions.join('\n\n') : undefined,
    priorTranscript ? `Conversation so far:\n\n${priorTranscript}` : undefined,
    userText,
  ]
    .filter((block): block is string => block !== undefined)
    .join('\n\n')

export type AcpAdapterDeps = {
  /** Override transport opening for tests. Production omits and the factory
   *  builds a WebSocket transport. */
  openTransport?: typeof openTransport
  /** Override SDK connection constructor for tests. */
  ClientSideConnection?: new (
    toClient: (agent: AcpSdkAgent) => Client,
    stream: AcpTransport['stream'],
  ) => ClientSideConnection
  webSocketFactory?: WebSocketFactory
  /** Override throttle for tests of the prompt → translator pipeline. */
  textDeltaThrottleMs?: number
  /** Connect-phase timeout (ms). Defaults to a generous 30s. Tests inject a
   *  small value to exercise the timeout path deterministically. */
  handshakeTimeoutMs?: number
}

/** Connection-scoped context — everything needed to open ONE shared transport.
 *  It deliberately omits per-thread fields (`acpSessionId`, `onAcpSessionId`,
 *  `requestPermission`, `onSessionSideEffect`): those vary per thread and are
 *  supplied on each `fetch` via {@link AgentAdapterContext}. */
export type AcpAdapterContext = {
  httpClient: AgentAdapterContext['httpClient']
  /** Agent-level sink for the commands the agent advertises via
   *  `available_commands_update`. Captured at the connection router (not the
   *  per-prompt translator) so the command list surfaces whenever the agent
   *  emits it — including before the first prompt, once a session exists. */
  onAvailableCommands?: (commands: AcpCommand[]) => void
}

/** Race a handshake step against a terminal-close signal and a timeout so a
 *  permanently-failed or silent transport surfaces a loud error instead of
 *  leaving `initialize`/`newSession` pending forever (the stuck-spinner bug).
 *  The `terminalClose` promise is the transport's `closed` (rejects on terminal
 *  close); when absent we fall back to timeout-only. */
const withHandshakeGuard = async <T>(
  step: Promise<T>,
  terminalClose: Promise<void> | undefined,
  timeoutMs: number,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ACP handshake timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  const racers = terminalClose ? [step, terminalClose as Promise<never>, timeout] : [step, timeout]
  try {
    return await Promise.race(racers)
  } finally {
    clearTimeout(timer)
  }
}

/** Open and handshake an ACP adapter against `agent`. The returned adapter owns
 *  a single transport/connection and multiplexes per-thread sessions over it —
 *  call `disconnect()` to tear it down on real teardown (agent delete / config
 *  edit / sign-out), NOT on thread switch. */
export const connectAcpAdapter = async (
  agent: Agent,
  ctx: AcpAdapterContext,
  deps: AcpAdapterDeps = {},
): Promise<AgentAdapter> => {
  if (!agent.url) {
    throw new Error(`ACP agent ${agent.id} has no url`)
  }
  if (agent.transport !== 'websocket' && agent.transport !== 'iroh') {
    throw new Error(`ACP agent ${agent.id} has unsupported transport ${agent.transport}`)
  }

  const transportFactory = deps.openTransport ?? openTransport
  const ConnectionCtor = deps.ClientSideConnection ?? ClientSideConnectionImpl

  const transportController = new AbortController()
  const transport = await transportFactory({
    url: agent.url,
    transport: agent.transport,
    agentType: agent.type,
    signal: transportController.signal,
    webSocketFactory: deps.webSocketFactory,
    // Managed-ACP uses `httpClient` presence to offer its signed bearer
    // subprotocol; iroh uses the client for transparent device enrollment.
    httpClient: ctx.httpClient,
  })

  // `session/update` notifications are routed to the owning thread's translator
  // by ACP `sessionId`. While a thread isn't actively prompting its entry is
  // absent and updates for it are dropped (the agent SHOULD only emit them
  // inside a turn anyway). A per-session map — never a single last-writer-wins
  // sink — is what prevents cross-thread bleed when two threads stream at once.
  const sessionUpdateSinks = new Map<string, (notification: SessionNotification) => void>()
  // Permission prompts also carry an ACP `sessionId`, so route them the same
  // way. A thread registers its handler while connected; the fallback cancels.
  const permissionHandlers = new Map<string, RequestPermissionFn>()

  const routeSessionUpdate = (notification: SessionNotification): void => {
    // The advertised command list is an agent-level capability, not part of a
    // single prompt's stream — capture it here regardless of whether a thread
    // is actively prompting, so commands surface before the first send too.
    if (notification.update.sessionUpdate === 'available_commands_update') {
      ctx.onAvailableCommands?.(toAcpCommands(notification.update.availableCommands))
      return
    }
    sessionUpdateSinks.get(notification.sessionId)?.(notification)
  }

  const routePermission: RequestPermissionFn = (request) => {
    const handler = permissionHandlers.get(request.sessionId)
    return (handler ?? cancelledPermission)(request)
  }

  const connection = new ConnectionCtor(
    () => createClientHandler(routeSessionUpdate, routePermission),
    transport.stream,
  )

  const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? defaultHandshakeTimeoutMs

  // A timed-out or terminally-closed `initialize` must tear the transport down
  // before rethrowing — otherwise the open WebSocket and its reconnect
  // machinery leak. The error still surfaces loudly so the chat fetch fails.
  const runInitialize = async (): Promise<AgentCapabilities> => {
    try {
      const initializeResponse = await withHandshakeGuard(
        connection.initialize({
          protocolVersion: protocolVersion,
          clientInfo: { name: clientName, version: clientVersion },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        }),
        transport.closed,
        handshakeTimeoutMs,
      )
      return adaptCapabilities(initializeResponse)
    } catch (err) {
      transportController.abort()
      transport.close()
      throw err
    }
  }

  const capabilities = await runInitialize()

  // Resolved ACP session id per chat thread. `null` while a thread's first
  // resolution is in flight is impossible — we store the in-flight promise so
  // concurrent sends on the same thread dedupe to one resume/load/new call.
  const sessionByThread = new Map<string, Promise<string>>()
  // Threads whose current session was freshly minted via `session/new`. Consumed
  // after the first real `fetch` persists the id; failed persistence restores the
  // marker. Deferring this out of resolution means warm-then-reload before any
  // prompt never persists an empty session id.
  type FreshSessionState = {
    readonly sessionId: string
    readonly persistence?: Promise<void>
  }
  const freshPending = new Map<string, FreshSessionState>()

  const guardHandshake = <T>(step: Promise<T>): Promise<T> =>
    withHandshakeGuard(step, transport.closed, handshakeTimeoutMs)

  /** Resolve (and cache) the ACP session id for the calling thread. First send
   *  on a thread with a stored id + a capable agent tries, in order,
   *  `session/resume` → `session/load`; a runtime rejection from either (the
   *  session was evicted on the agent, wire still alive) degrades to the next
   *  tier. With no stored id, no capability, or both tiers falling through, it
   *  mints a fresh `session/new` (tier-3, app-side transcript replay in `fetch`).
   *  A genuinely dead transport is not silently downgraded: `resolveNew`'s own
   *  guarded handshake rejects there too, surfacing loudly. Subsequent sends
   *  reuse the cached id. */
  const resolveThreadSession = (context: EnsureSessionContext): Promise<string> => {
    const existing = sessionByThread.get(context.threadId)
    if (existing) {
      return existing
    }
    const resolveNew = async (): Promise<string> => {
      const newSession = await guardHandshake(connection.newSession({ cwd: sessionCwd, mcpServers: [] }))
      // Defer persistence + transcript seeding to the first real send.
      freshPending.set(context.threadId, { sessionId: newSession.sessionId })
      return newSession.sessionId
    }
    // Try a stored-session restore, swallowing a runtime rejection (session
    // evicted on the agent, wire still alive) into `false` so the caller degrades
    // to the next tier. A genuinely dead transport also lands here as `false`,
    // then surfaces loudly at `resolveNew`'s own guarded handshake.
    const tryRestore = (restore: Promise<unknown>): Promise<boolean> =>
      guardHandshake(restore).then(
        () => true,
        () => false,
      )
    const resolve = (async (): Promise<string> => {
      const stored = context.acpSessionId
      // `resume` restores execution state with no replay; `load` has the agent
      // replay its own transcript over `session/update`. Resume is tried first.
      if (
        stored &&
        capabilities.resume &&
        (await tryRestore(connection.resumeSession({ sessionId: stored, cwd: sessionCwd, mcpServers: [] })))
      ) {
        return stored
      }
      if (
        stored &&
        capabilities.loadSession &&
        (await tryRestore(connection.loadSession({ sessionId: stored, cwd: sessionCwd, mcpServers: [] })))
      ) {
        return stored
      }
      return resolveNew()
    })()
    // Evict on failure so a transient handshake error doesn't poison the thread
    // — the next send retries a fresh resolution.
    resolve.catch(() => sessionByThread.delete(context.threadId))
    sessionByThread.set(context.threadId, resolve)
    return resolve
  }

  /** Persist and consume one freshly minted session marker. A failed write
   *  restores the marker so the next send retries instead of silently losing
   *  both durable session continuity and first-send transcript replay. */
  const consumeFreshSession = async (context: AgentAdapterContext, sessionId: string): Promise<boolean> => {
    const pending = freshPending.get(context.threadId)
    if (!pending || pending.sessionId !== sessionId) {
      return false
    }
    if (pending.persistence) {
      await pending.persistence
      return false
    }

    const persistence = context.onAcpSessionId(sessionId)
    freshPending.set(context.threadId, { sessionId, persistence })
    try {
      await persistence
      if (freshPending.get(context.threadId)?.persistence === persistence) {
        freshPending.delete(context.threadId)
      }
      return true
    } catch (error) {
      if (freshPending.get(context.threadId)?.persistence === persistence) {
        freshPending.set(context.threadId, { sessionId })
      }
      throw error
    }
  }

  const fetch = async (init: RequestInit, context: AgentAdapterContext): Promise<Response> => {
    const sessionId = await resolveThreadSession(context)

    // First real send of a freshly-minted session: persist the id we actually
    // used, and (tier-3 only) seed the prior transcript as context. The marker
    // is keyed on "fresh session's first prompt" (not "we prepended a
    // transcript") so a brand-new thread's second prompt never re-injects its
    // first exchange. Consumption happens only after persistence succeeds.
    const isFirstSendOfFreshSession = await consumeFreshSession(context, sessionId)
    const priorTranscript = isFirstSendOfFreshSession ? extractPriorTranscript(init) : undefined
    const prompt = await buildPromptBlocks(
      init,
      context.skillInstructions,
      capabilities.promptCapabilities.embeddedContext,
      defaultPromptBlockDeps,
      priorTranscript,
    )

    const { body, translator, close } = createTranslatorStream({
      textDeltaThrottleMs: deps.textDeltaThrottleMs,
      onSideEffect: context.onSessionSideEffect,
    })

    sessionUpdateSinks.set(sessionId, (notification) => translator.handle(notification))
    if (context.requestPermission) {
      permissionHandlers.set(sessionId, context.requestPermission)
    }

    translator.start()

    // One idempotent teardown shared by every exit path — the prompt
    // resolving, the prompt erroring, and the user hitting Stop (signal abort).
    // It drops this turn's routing handlers, closes the translator stream, and
    // detaches the abort listener so nothing leaks.
    const { signal } = init
    let tornDown = false
    const teardown = (): void => {
      if (tornDown) {
        return
      }
      tornDown = true
      signal?.removeEventListener('abort', onAbort)
      sessionUpdateSinks.delete(sessionId)
      permissionHandlers.delete(sessionId)
      translator.finish()
      close()
    }

    // Stop: the AI SDK aborts the *local* stream, but the remote ACP turn keeps
    // running (burning tokens, still executing tool calls) until we tell the
    // agent. Send `session/cancel` — fire-and-forget, since teardown must not
    // block on the wire — then run the same teardown.
    const onAbort = (): void => {
      // Fire-and-forget: teardown must not block on the wire. A rejection means
      // the transport is already tearing down (the turn is ending anyway), so
      // swallow it to avoid an unhandled rejection — matching the sibling
      // `sessionUpdate` write above.
      void connection.cancel({ sessionId }).catch(() => {})
      teardown()
    }

    // Drive the prompt off the request thread — the response stream is the
    // synchronous return value so the AI SDK can attach immediately.
    void (async () => {
      try {
        const response = await connection.prompt({
          sessionId,
          prompt,
        })
        // The Haystack adapter mirrors citation metadata on the terminal
        // `agent_message_chunk` AND on the `PromptResponse._meta`. Ingesting
        // both makes us resilient to adapters that only set one path.
        translator.ingestMeta(response._meta)
      } catch (err) {
        translator.error(err instanceof Error ? err.message : String(err))
      } finally {
        teardown()
      }
    })()

    // A signal already aborted before we attached the listener still cancels.
    if (signal?.aborted) {
      onAbort()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }

    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  // Warm the thread's session ahead of the first prompt so the agent emits its
  // `available_commands_update` (captured by `routeSessionUpdate`) before the
  // user sends anything. The session is cached per thread, so the subsequent
  // first `fetch` reuses it — no extra `session/new`. Warming deliberately does
  // NOT persist a freshly-minted id (that is deferred to the first real send):
  // a reload after warming but before any prompt must leave the thread on its
  // old/`null` id so it re-resolves correctly instead of resuming an empty one.
  const ensureSession = async (context: EnsureSessionContext): Promise<void> => {
    await resolveThreadSession(context)
  }

  const disconnect = (): void => {
    transportController.abort()
    transport.close()
  }

  return {
    agent,
    capabilities,
    fetch,
    ensureSession,
    disconnect,
  }
}
