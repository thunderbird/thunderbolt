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
import type { ChatThread, Mode, Model, SaveMessagesFunction } from '@/types'

/** Capabilities advertised by an ACP agent on `initialize`. Stored on the
 *  adapter so the connect logic can branch on `loadSession` and future
 *  prompt-capability flags surface to the composer. */
export type AgentCapabilities = {
  loadSession: boolean
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
  transport: 'in-process' | 'websocket'
  url: string | null
  description: string | null
  icon: string | null
  isSystem: 0 | 1
  enabled: 0 | 1
  deletedAt: string | null
  userId: string | null
  /** Workspace visibility for user-custom (`remote-acp`) agents. Synced
   *  workspace-scoped tables carry this column (THU-603); built-in / system
   *  agents leave it absent since the distinction doesn't apply. */
  scope?: 'workspace' | 'user' | null
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
  selectedMode: Mode
  selectedModel: Model
  mcpClients: NamedMCPClient[]
  /** Reconnect a dropped MCP client at the `tools()` boundary; returns a fresh
   *  client or null. Supplied by the MCP provider via the chat store. */
  reconnectClient: (client: MCPClient) => Promise<MCPClient | null>
  httpClient: HttpClient
  getProxyFetch: () => FetchFn
  /** Resolved instruction bodies for any user skills (`/slug`) referenced in
   *  the prompt. The built-in pipeline injects these as system messages
   *  (`ai/fetch.ts`); ACP agents only receive prompt text, so the adapter folds
   *  them into the prompt instead — keeping skills behaving the same across
   *  agents. Empty/omitted when no skill token resolved. */
  skillInstructions?: string[]
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
export type EnsureSessionContext = Pick<AgentAdapterContext, 'threadId' | 'acpSessionId' | 'onAcpSessionId'>

/** Runtime adapter wrapping either the built-in pipeline or an ACP transport.
 *  `customFetch` in `chat-instance.ts` delegates to `adapter.fetch` and returns
 *  the resulting `Response` to the AI SDK unchanged. */
export type AgentAdapter = {
  agent: Agent
  /** `null` for the built-in adapter (no ACP handshake). */
  capabilities: AgentCapabilities | null
  fetch: (init: RequestInit, context: AgentAdapterContext) => Promise<Response>
  /** Eagerly resolve the thread's ACP session (no prompt), so the agent emits
   *  its advertised commands before the first send. No-op for the built-in
   *  adapter. Idempotent per thread — reuses the cached session. */
  ensureSession: (context: EnsureSessionContext) => Promise<void>
  disconnect: () => void
}

/** Factory used by the chat layer's per-session adapter cache. Async because
 *  remote-acp adapters open a transport and complete `initialize` + (`session/new`
 *  or `session/load`) before returning. */
export type AgentAdapterFactory = (
  agent: Agent,
  context: { httpClient: HttpClient; getProxyFetch: () => FetchFn },
) => Promise<AgentAdapter>
