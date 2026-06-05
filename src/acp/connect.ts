/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Public entry point for the chat layer. Given an `Agent` row + a
 * connection-scoped context, return an `AgentAdapter` whose `fetch(init, ctx)`
 * produces a streaming `Response` shaped for the AI SDK.
 *
 *   - `built-in` → wraps `aiFetchStreamingResponse` (no ACP wire).
 *   - `remote-acp` / `managed-acp` → opens transport + ACP `initialize`.
 *
 * The chat layer caches ONE adapter per agent (see `src/acp/adapter-cache.ts`)
 * and reuses it across every thread that targets that agent. Per-thread ACP
 * sessions, permission prompts, and side-effect sinks are supplied on each
 * `adapter.fetch(init, ctx)` call — not here — so a single connection can
 * multiplex many threads. The cache tears the adapter down via
 * `adapter.disconnect()` only on real teardown (agent delete / config edit /
 * sign-out), never on thread switch.
 */

import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Agent, AgentAdapter } from '@/types/acp'
import { connectAcpAdapter, type AcpAdapterDeps } from './acp-adapter'
import { createBuiltInAdapter, type BuiltInAdapterOptions } from './built-in-adapter'

/** Connection-scoped context handed to {@link connectToAgent}. Deliberately
 *  carries only what's needed to OPEN a connection — per-thread fields travel
 *  on each `adapter.fetch` call instead, so one connection serves many threads. */
export type ConnectToAgentContext = {
  httpClient: HttpClient
  getProxyFetch: () => FetchFn
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
    { httpClient: ctx.httpClient },
    {
      openTransport: deps.openTransport,
      ClientSideConnection: deps.ClientSideConnection,
      webSocketFactory: deps.webSocketFactory,
      textDeltaThrottleMs: deps.textDeltaThrottleMs,
      handshakeTimeoutMs: deps.handshakeTimeoutMs,
    },
  )
}
