/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Public entry point for the chat layer. Given an `Agent` row + per-call
 * context, return an `AgentAdapter` whose `fetch(init, ctx)` produces a
 * streaming `Response` shaped for the AI SDK.
 *
 *   - `built-in` → wraps `aiFetchStreamingResponse` (no ACP wire).
 *   - `remote-acp` / `managed-acp` → opens transport + ACP handshake.
 *
 * The chat layer caches one adapter per `(sessionId, agentId)` and tears it
 * down via `adapter.disconnect()` when the session ends or the user switches
 * agents mid-thread.
 */

import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Agent, AgentAdapter } from '@/types/acp'
import { connectAcpAdapter, type AcpAdapterDeps, type RequestPermissionFn } from './acp-adapter'
import { createBuiltInAdapter, type BuiltInAdapterOptions } from './built-in-adapter'
import type { SessionSideEffectSink } from './translators/acp-to-ai-sdk'

export type ConnectToAgentContext = {
  httpClient: HttpClient
  getProxyFetch: () => FetchFn
  /** Persisted ACP session id from `chat_threads.acp_session_id`. Null for
   *  the first message in a thread or for agents without `loadSession`. */
  acpSessionId?: string | null
  onAcpSessionId?: (sessionId: string) => Promise<void>
  /** Forwarded to ACP adapters so they can prompt the UI for tool-call
   *  approvals. Ignored for built-in agents. */
  requestPermission?: RequestPermissionFn
  /** Forwarded to ACP adapters so the chat layer can react to server-driven
   *  mode and config updates. Ignored for built-in agents. */
  onSessionSideEffect?: SessionSideEffectSink
}

export type ConnectToAgentDeps = BuiltInAdapterOptions & AcpAdapterDeps

/** Build an `AgentAdapter` for the given agent. */
export const connectToAgent = async (
  agent: Agent,
  ctx: ConnectToAgentContext,
  deps: ConnectToAgentDeps = {},
): Promise<AgentAdapter> => {
  if (agent.type === 'built-in') {
    return createBuiltInAdapter(agent, { aiFetch: deps.aiFetch })
  }
  return connectAcpAdapter(
    agent,
    {
      httpClient: ctx.httpClient,
      getProxyFetch: ctx.getProxyFetch,
      acpSessionId: ctx.acpSessionId ?? null,
      onAcpSessionId: ctx.onAcpSessionId ?? (async () => {}),
      requestPermission: ctx.requestPermission,
      onSessionSideEffect: ctx.onSessionSideEffect,
    },
    {
      openTransport: deps.openTransport,
      ClientSideConnection: deps.ClientSideConnection,
      webSocketFactory: deps.webSocketFactory,
      textDeltaThrottleMs: deps.textDeltaThrottleMs,
    },
  )
}
