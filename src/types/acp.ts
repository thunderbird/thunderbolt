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

import type { MCPClient } from '@ai-sdk/mcp'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
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
  mcpClients: MCPClient[]
  httpClient: HttpClient
  getProxyFetch: () => FetchFn
  /** Called when an ACP adapter created a fresh `sessionId` via `session/new`.
   *  The chat layer persists it on `chatThreads.acpSessionId` so future loads
   *  can call `session/load` when the agent supports it. */
  onAcpSessionId: (sessionId: string) => Promise<void>
}

/** Runtime adapter wrapping either the built-in pipeline or an ACP transport.
 *  `customFetch` in `chat-instance.ts` delegates to `adapter.fetch` and returns
 *  the resulting `Response` to the AI SDK unchanged. */
export type AgentAdapter = {
  agent: Agent
  /** `null` for the built-in adapter (no ACP handshake). */
  capabilities: AgentCapabilities | null
  fetch: (init: RequestInit, context: AgentAdapterContext) => Promise<Response>
  disconnect: () => void
}

/** Factory used by the chat layer's per-session adapter cache. Async because
 *  remote-acp adapters open a transport and complete `initialize` + (`session/new`
 *  or `session/load`) before returning. */
export type AgentAdapterFactory = (
  agent: Agent,
  context: { httpClient: HttpClient; getProxyFetch: () => FetchFn },
) => Promise<AgentAdapter>
