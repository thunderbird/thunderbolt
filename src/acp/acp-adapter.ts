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
 *      session lazily and once: if `ctx.acpSessionId` is set AND the agent
 *      advertises `loadSession` it calls `loadSession`, otherwise it calls
 *      `newSession`, captures the fresh id, and persists it via
 *      `ctx.onAcpSessionId`. The resolved id is cached per thread so repeated
 *      sends on the same thread never re-resolve. Both calls go through the
 *      same handshake guard as `initialize`.
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
/** ACP requires `cwd` on session/new + session/load. Browser/web agents have
 *  no real filesystem; we send a placeholder. The Haystack managed adapter
 *  and most remote agents ignore the field. */
const sessionCwd = '/'
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
    promptCapabilities: {
      image: caps?.promptCapabilities?.image ?? false,
      audio: caps?.promptCapabilities?.audio ?? false,
      embeddedContext: caps?.promptCapabilities?.embeddedContext ?? false,
    },
  }
}

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
): Promise<ContentBlock[]> => {
  if (typeof init.body !== 'string') {
    throw new Error('ACP adapter expects string body on init')
  }
  const parsed = JSON.parse(init.body) as { messages: ThunderboltUIMessage[] }
  const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user')
  if (!lastUser) {
    throw new Error('ACP adapter: no user message in request body')
  }
  const userText = lastUser.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  // Skill instructions ride the text block (ACP has no system channel) — see composeAcpPrompt.
  const text = composeAcpPrompt(skillInstructions, userText)

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

/** Fold resolved user-skill instructions into the prompt text. ACP has no
 *  separate system channel (the prompt is content blocks), so we prepend the
 *  instructions ahead of the user's message — mirroring how the built-in
 *  pipeline prepends them as system messages, just over the only channel ACP
 *  gives us. No instructions → the user text is sent unchanged. */
const composeAcpPrompt = (skillInstructions: string[] | undefined, userText: string): string =>
  skillInstructions && skillInstructions.length > 0 ? `${skillInstructions.join('\n\n')}\n\n${userText}` : userText

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
  if (agent.transport !== 'websocket') {
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
    // `httpClient` presence signals an authenticated cloud backend is wired:
    // managed-ACP offers the signed bearer subprotocol when it's set; remote-ACP
    // ignores it (the universal proxy / native WebSocket carry their own auth).
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
  // concurrent sends on the same thread dedupe to one load/new call.
  const sessionByThread = new Map<string, Promise<string>>()

  /** Resolve (and cache) the ACP session id for the calling thread. First send
   *  on a thread runs `loadSession` (when supported + a prior id exists) or
   *  `newSession`; subsequent sends reuse the cached id. */
  const resolveThreadSession = (context: EnsureSessionContext): Promise<string> => {
    const existing = sessionByThread.get(context.threadId)
    if (existing) {
      return existing
    }
    const resolve = (async (): Promise<string> => {
      if (context.acpSessionId && capabilities.loadSession) {
        await withHandshakeGuard(
          connection.loadSession({ sessionId: context.acpSessionId, cwd: sessionCwd, mcpServers: [] }),
          transport.closed,
          handshakeTimeoutMs,
        )
        return context.acpSessionId
      }
      const newSession = await withHandshakeGuard(
        connection.newSession({ cwd: sessionCwd, mcpServers: [] }),
        transport.closed,
        handshakeTimeoutMs,
      )
      await context.onAcpSessionId(newSession.sessionId)
      return newSession.sessionId
    })()
    // Evict on failure so a transient handshake error doesn't poison the thread
    // — the next send retries a fresh resolution.
    resolve.catch(() => sessionByThread.delete(context.threadId))
    sessionByThread.set(context.threadId, resolve)
    return resolve
  }

  const fetch = async (init: RequestInit, context: AgentAdapterContext): Promise<Response> => {
    const prompt = await buildPromptBlocks(
      init,
      context.skillInstructions,
      capabilities.promptCapabilities.embeddedContext,
    )
    const sessionId = await resolveThreadSession(context)

    const { body, translator, close } = createTranslatorStream({
      textDeltaThrottleMs: deps.textDeltaThrottleMs,
      onSideEffect: context.onSessionSideEffect,
    })

    sessionUpdateSinks.set(sessionId, (notification) => translator.handle(notification))
    if (context.requestPermission) {
      permissionHandlers.set(sessionId, context.requestPermission)
    }

    translator.start()

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
        sessionUpdateSinks.delete(sessionId)
        permissionHandlers.delete(sessionId)
        translator.finish()
        close()
      }
    })()

    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  // Warm the thread's session ahead of the first prompt so the agent emits its
  // `available_commands_update` (captured by `routeSessionUpdate`) before the
  // user sends anything. The session is cached per thread, so the subsequent
  // first `fetch` reuses it — no extra `session/new`.
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
