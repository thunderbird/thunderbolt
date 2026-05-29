/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Generic ACP adapter. Used for both `remote-acp` and `managed-acp` agents —
 * the wire is identical, only the URL provenance differs.
 *
 * Lifecycle:
 *   1. `connectAcpAdapter(agent, ctx)` opens the transport, builds a
 *      `ClientSideConnection`, sends `initialize`, and stashes the agent
 *      capabilities reported by the server.
 *   2. If the chat thread carries a prior `acpSessionId` AND the agent
 *      advertises `loadSession`, the adapter calls `loadSession`. Otherwise
 *      it calls `newSession`, captures the fresh id, and notifies the chat
 *      layer via `ctx.onAcpSessionId(newId)`.
 *   3. Each `adapter.fetch(init, ctx)` parses the most recent user message,
 *      sends `prompt` with a single text `ContentBlock`, and pipes the
 *      `sessionUpdate` notifications through the translator into a
 *      `ReadableStream<Uint8Array>` that AI SDK consumes.
 *   4. `disconnect()` closes the transport (which aborts the SDK connection
 *      via its internal AbortSignal).
 */

import type {
  Agent as AcpSdkAgent,
  ClientSideConnection,
  Client,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import { ClientSideConnection as ClientSideConnectionImpl } from '@agentclientprotocol/sdk'
import type { Agent, AgentAdapter, AgentAdapterContext, AgentCapabilities } from '@/types/acp'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { ThunderboltUIMessage } from '@/types'
import { openTransport } from './transports'
import type { AcpTransport } from './types'
import { createTranslatorStream, type SessionSideEffectSink } from './translators/acp-to-ai-sdk'
import type { WebSocketFactory } from './transports/websocket'

const protocolVersion = 1
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
 *  We accept tool calls / session updates but never request files or terminals
 *  in MVP. All `sessionUpdate` notifications flow into the caller's sink, and
 *  permission prompts are forwarded to the supplied `requestPermission`. */
const createClientHandler = (
  onSessionUpdate: (notification: SessionNotification) => void,
  requestPermission: RequestPermissionFn,
): Client => ({
  sessionUpdate: async (params) => {
    onSessionUpdate(params)
  },
  requestPermission,
})

const adaptCapabilities = (response: InitializeResponse): AgentCapabilities => {
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

/** Extract the trailing user-message text from the AI SDK request body. The
 *  built-in transport posts `{ messages: ThunderboltUIMessage[], id }`; we
 *  forward only the last user message's concatenated text parts to ACP.
 *  Non-text parts are dropped — the MVP `promptCapabilities` are all false. */
const extractUserPrompt = (init: RequestInit): string => {
  if (typeof init.body !== 'string') {
    throw new Error('ACP adapter expects string body on init')
  }
  const parsed = JSON.parse(init.body) as { messages: ThunderboltUIMessage[] }
  const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user')
  if (!lastUser) {
    throw new Error('ACP adapter: no user message in request body')
  }
  return lastUser.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

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
}

export type AcpAdapterContext = {
  httpClient: AgentAdapterContext['httpClient']
  getProxyFetch: () => FetchFn
  /** Persisted ACP session id from `chat_threads.acp_session_id` — null when
   *  this is the first message in a thread or the agent doesn't support
   *  `loadSession`. */
  acpSessionId: string | null
  onAcpSessionId: AgentAdapterContext['onAcpSessionId']
  /** Invoked when the agent requests permission for a tool call. The chat
   *  layer surfaces a dialog and resolves the response. Optional; defaults to
   *  auto-cancelling so unwired agents stay safe. */
  requestPermission?: RequestPermissionFn
  /** Invoked when the agent emits a `current_mode_update` or
   *  `config_option_update`. The chat layer reflects the new server state in
   *  the store. Optional; default is no-op. */
  onSessionSideEffect?: SessionSideEffectSink
}

/** Open and handshake an ACP adapter against `agent`. The returned adapter is
 *  bound to a single transport/connection — call `disconnect()` to tear it
 *  down when the chat session is destroyed. */
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
    // Managed-ACP needs the authenticated client to mint a single-use
    // WebSocket ticket; remote-ACP ignores it (the universal proxy / native
    // WebSocket carry their own auth).
    httpClient: ctx.httpClient,
  })

  // The `sessionUpdate` sink is rebound per prompt-turn so notifications from
  // one prompt never leak into the next. While no prompt is active, updates
  // are no-ops (the agent SHOULD only emit them inside a turn anyway).
  let sessionUpdateSink: (notification: SessionNotification) => void = () => {}

  const requestPermission = ctx.requestPermission ?? cancelledPermission

  const connection = new ConnectionCtor(
    () => createClientHandler((n) => sessionUpdateSink(n), requestPermission),
    transport.stream,
  )

  const initializeResponse = await connection.initialize({
    protocolVersion: protocolVersion,
    clientInfo: { name: clientName, version: clientVersion },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  })

  const capabilities = adaptCapabilities(initializeResponse)

  const resolveSessionId = async (): Promise<string> => {
    if (ctx.acpSessionId && capabilities.loadSession) {
      await connection.loadSession({
        sessionId: ctx.acpSessionId,
        cwd: sessionCwd,
        mcpServers: [],
      })
      return ctx.acpSessionId
    }
    const newSession = await connection.newSession({ cwd: sessionCwd, mcpServers: [] })
    await ctx.onAcpSessionId(newSession.sessionId)
    return newSession.sessionId
  }

  const sessionId = await resolveSessionId()

  const fetch = async (init: RequestInit, _context: AgentAdapterContext): Promise<Response> => {
    const promptText = extractUserPrompt(init)

    const { body, translator, close } = createTranslatorStream({
      textDeltaThrottleMs: deps.textDeltaThrottleMs,
      onSideEffect: ctx.onSessionSideEffect,
    })

    sessionUpdateSink = (notification) => {
      if (notification.sessionId !== sessionId) {
        return
      }
      translator.handle(notification)
    }

    translator.start()

    // Drive the prompt off the request thread — the response stream is the
    // synchronous return value so the AI SDK can attach immediately.
    void (async () => {
      try {
        const response = await connection.prompt({
          sessionId,
          prompt: [{ type: 'text', text: promptText }],
        })
        // The Haystack adapter mirrors citation metadata on the terminal
        // `agent_message_chunk` AND on the `PromptResponse._meta`. Ingesting
        // both makes us resilient to adapters that only set one path.
        translator.ingestMeta(response._meta)
      } catch (err) {
        translator.error(err instanceof Error ? err.message : String(err))
      } finally {
        sessionUpdateSink = () => {}
        translator.finish()
        close()
      }
    })()

    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  const disconnect = (): void => {
    transportController.abort()
    transport.close()
  }

  return {
    agent,
    capabilities,
    fetch,
    disconnect,
  }
}
