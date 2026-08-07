/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Frontend-only types for the ACP (Agent Client Protocol) feature.
 *
 * The shared wire types live in `shared/acp-types.ts`; this file extends them
 * with the runtime `Agent` row shape (synced + local + built-in unified) plus
 * the adapter contract consumed by `src/chats/chat-instance.ts` `customFetch`.
 */

import type { MCPClient, NamedMCPClient } from '@/lib/mcp-provider'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { SessionSideEffectSink } from '@/acp/translators/acp-to-ai-sdk'
import type { TurnBudgetConsumer } from '@/ai/retry-budget'
import type { ChatThread, Model, SaveMessagesFunction } from '@/types'
import type { RunSpec } from '@shared/acp-types'

/** Capabilities advertised by an ACP agent on `initialize`. Stored on the
 *  adapter so the connect logic can branch on `loadSession` and future
 *  prompt-capability flags surface to the composer. */
export type AgentCapabilities = {
  loadSession: boolean
  /** Agent accepts enabled skill definitions through Thunderbolt's namespaced
   *  ACP session metadata extension. */
  skills: boolean
  /** Agent advertises `sessionCapabilities.resume` (`session/resume`): it can
   *  restore a prior session's private execution state from its own store
   *  WITHOUT replaying the transcript (unlike `loadSession`). Lets the app hand
   *  back a stored `acpSessionId` and continue a thread without re-seeding
   *  context. Experimental in `@agentclientprotocol/sdk` — version-pinned. */
  resume: boolean
  /** Agent advertises Thunderbolt's detached-turn extension on `initialize`: a
   *  prompt turn keeps running after the transport drops, and a reconnecting
   *  client can replay the missed updates (see `shared/acp-types.ts`). */
  detachedTurns: boolean
  promptCapabilities: {
    image: boolean
    audio: boolean
    embeddedContext: boolean
  }
}

/** Unified Agent row used across UI, DAL, and chat routing. Combines fields
 *  from the synced `agents` table (user customs), the local-only `agents_system`
 *  table (env-var-discovered), and the hardcoded built-in default. */
export type Agent = {
  id: string
  name: string
  type: 'built-in' | 'remote-acp' | 'managed-acp'
  /** `iroh` is a remote-acp agent dialed peer-to-peer over an n0 relay; its
   *  `url` carries the bridge's NodeId/ticket instead of a `ws(s)://` URL. */
  transport: 'in-process' | 'websocket' | 'iroh'
  url: string | null
  description: string | null
  icon: string | null
  isSystem: 0 | 1
  enabled: 0 | 1
  deletedAt: string | null
  userId: string | null
}

/** Per-request context handed to `AgentAdapter.fetch`. Carries everything the
 *  built-in adapter passes to `aiFetchStreamingResponse` AND everything the
 *  ACP adapter needs to translate ACP `sessionUpdate` notifications into
 *  AI SDK v5 UI message stream chunks. */
export type AgentAdapterContext = {
  threadId: string
  chatThread: ChatThread | null
  acpSessionId: string | null
  saveMessages: SaveMessagesFunction
  selectedModel: Model
  mcpClients: NamedMCPClient[]
  /** Reconnect a dropped MCP client at the `tools()` boundary; returns a fresh
   *  client or null. Supplied by the MCP provider via the chat store. */
  reconnectClient: (client: MCPClient) => Promise<MCPClient | null>
  httpClient: HttpClient
  getProxyFetch: () => FetchFn
  turnBudget?: TurnBudgetConsumer
  /** Increments only when the current assistant response is regenerated. Built-in
   *  persistent harnesses use it to rebuild from the edited transcript without
   *  rebuilding during ordinary transcript growth. */
  regenerationRevision?: number
  /** Resolved instruction bodies for any user skills (`/slug`) referenced in
   *  the prompt. The built-in pipeline injects these as system messages
   *  (`ai/fetch.ts`); ACP agents only receive prompt text, so the adapter folds
   *  them into the prompt instead — keeping skills behaving the same across
   *  agents. Empty/omitted when no skill token resolved. */
  skillInstructions?: string[]
  /** Model + reasoning depth this turn must execute under, for agents that run
   *  the client's chosen model instead of their own (the cloud runner). Absent
   *  for agents that own their model, whose sessions carry no run spec. */
  runSpec?: RunSpec
  /** Called when an ACP adapter created a fresh `sessionId` via `session/new`.
   *  The chat layer persists it on `chatThreads.acpSessionId` so future loads
   *  can call `session/load` when the agent supports it. */
  onAcpSessionId: (sessionId: string) => Promise<void>
  /** Invoked when the agent requests permission for a tool call on THIS
   *  thread's ACP session. The chat layer surfaces a dialog and resolves the
   *  response. Optional; a shared ACP connection routes each thread's prompts
   *  to its own handler so dialogs never cross threads. */
  requestPermission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>
  /** Invoked when the agent emits a `current_mode_update` or
   *  `config_option_update` on this thread's session. Optional; default no-op. */
  onSessionSideEffect?: SessionSideEffectSink
}

/** The slice of {@link AgentAdapterContext} needed to resolve a thread's ACP
 *  session without sending a prompt. Used by `ensureSession` to warm the
 *  connection — creating `session/new` early so the agent emits its
 *  `available_commands_update` before the user's first message. */
export type EnsureSessionContext = Pick<AgentAdapterContext, 'threadId' | 'acpSessionId' | 'onAcpSessionId' | 'runSpec'>

/** What `reattach` actually consumes: session resolution plus the per-thread
 *  handlers a replayed turn can still trigger. Deliberately not the full
 *  {@link AgentAdapterContext} — catch-up sends no prompt, so the prompt-path
 *  wiring (models, MCP clients, persistence callbacks) would be dead weight at
 *  the call site. */
export type ReattachContext = EnsureSessionContext &
  Pick<AgentAdapterContext, 'requestPermission' | 'onSessionSideEffect'>

/** Runtime adapter wrapping either the built-in pipeline or an ACP transport.
 *  `customFetch` in `chat-instance.ts` delegates to `adapter.fetch` and returns
 *  the resulting `Response` to the AI SDK unchanged. */
export type AgentAdapter = {
  agent: Agent
  /** `null` for the built-in adapter (no ACP handshake). */
  capabilities: AgentCapabilities | null
  /** Settles when this remote adapter generation terminates. Absent for the
   *  built-in adapter, which has no transport lifecycle. */
  closed?: Promise<void>
  fetch: (init: RequestInit, context: AgentAdapterContext) => Promise<Response>
  /** Eagerly resolve the thread's ACP session (no prompt), so the agent emits
   *  its advertised commands before the first send. No-op for the built-in
   *  adapter. Idempotent per thread — reuses the cached session. */
  ensureSession: (context: EnsureSessionContext) => Promise<void>
  /** Catch up on a turn that ran (or is still running) on a detached-turns
   *  agent while this client was away: replays the latest turn's updates as a
   *  UI message stream and keeps streaming live ones until the turn ends.
   *  Resolves `null` when there is nothing to catch up on (agent without the
   *  capability, no stored session, or no turn to replay). `replaceMessageId`
   *  stamps the streamed assistant message with an existing message id so a
   *  persisted partial row is replaced instead of duplicated. Absent on the
   *  built-in adapter. */
  reattach?: (context: ReattachContext, replaceMessageId?: string) => Promise<Response | null>
  /** Ask a detached-turns agent to hard-delete everything it holds for a
   *  session. No-ops for agents without the capability — a detached turn is the
   *  only reason server-side state outlives the client, so it is the only state
   *  that needs erasing. Absent on the built-in adapter. */
  deleteRunnerSession?: (sessionId: string) => Promise<void>
  disconnect: () => void
}

/** Factory used by the chat layer's per-session adapter cache. Async because
 *  remote-acp adapters open a transport and complete `initialize` + (`session/new`
 *  or `session/load`) before returning. */
export type AgentAdapterFactory = (
  agent: Agent,
  context: { httpClient: HttpClient; getProxyFetch: () => FetchFn },
) => Promise<AgentAdapter>
