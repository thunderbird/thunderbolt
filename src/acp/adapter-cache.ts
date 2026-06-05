/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Global, lazy ACP adapter cache — ONE connection per agent, reused across
 * every chat thread that targets that agent.
 *
 * Why module-level: a chat thread is created per `Chat` instance, so a
 * per-instance cache would open a fresh transport for every thread (and leak
 * N connections for N threads on the same agent). Hoisting the cache to module
 * scope makes the connection follow the AGENT, not the thread, so switching
 * threads on the same agent reuses the warm connection instead of reconnecting.
 *
 * Lazy: a connection opens only when `getOrConnectAdapter` is called, which the
 * routing fetch does on the FIRST actual send of a thread the user opened.
 * Nothing iterates agents or pre-warms on hydrate, so unopened history threads
 * never open a connection.
 *
 * The cache stores the connect PROMISE (not the resolved adapter) so concurrent
 * first-uses dedupe to a single connect. A rejected connect is evicted so the
 * next call retries against a fresh transport instead of replaying a poisoned
 * one.
 *
 * Teardown is explicit and rare: `disposeAdapter(agentId)` on agent delete or a
 * connection-invalidating config edit (url/transport/type), and
 * `disposeAllAdapters()` on sign-out. Thread switch does NOT dispose.
 */

import { connectToAgent as defaultConnectToAgent } from './connect'
import type { ConnectToAgentContext, ConnectToAgentDeps } from './connect'
import type { Agent, AgentAdapter } from '@/types/acp'

const cache = new Map<string, Promise<AgentAdapter>>()

/** DI seam so tests can inject a counting/fake `connectToAgent` without
 *  `mock.module()`. Production omits and binds to the real entry point. */
export type AdapterCacheDeps = {
  connectToAgent?: typeof defaultConnectToAgent
}

/**
 * Return the cached adapter for `agent`, connecting once on first use. Concurrent
 * callers awaiting the same agent share a single in-flight connect. A failed
 * connect is evicted so a later call can retry.
 */
export const getOrConnectAdapter = async (
  agent: Agent,
  ctx: ConnectToAgentContext,
  deps: AdapterCacheDeps & ConnectToAgentDeps = {},
): Promise<AgentAdapter> => {
  const cached = cache.get(agent.id)
  if (cached) {
    return cached
  }

  const connect = deps.connectToAgent ?? defaultConnectToAgent
  const pending = connect(agent, ctx, deps)
  // Evict a failed connect so the poisoned promise isn't replayed on retry.
  pending.catch(() => {
    if (cache.get(agent.id) === pending) {
      cache.delete(agent.id)
    }
  })
  cache.set(agent.id, pending)
  return pending
}

/** Await an in-flight (or settled) connect and disconnect the resulting adapter.
 *  Awaiting first means we tear down a fully-formed adapter rather than racing
 *  teardown against an open handshake. A connect that rejected was already
 *  evicted by `getOrConnectAdapter`, so swallow its rejection here. */
const disconnectPending = async (pending: Promise<AgentAdapter>): Promise<void> => {
  const adapter = await pending.catch(() => null)
  adapter?.disconnect()
}

/**
 * Tear down and evict the cached adapter for `agentId`. Call on agent delete or
 * a config edit that invalidates the warm connection (url/transport/type). A
 * no-op when no connection exists for the agent.
 */
export const disposeAdapter = async (agentId: string): Promise<void> => {
  const pending = cache.get(agentId)
  if (!pending) {
    return
  }
  cache.delete(agentId)
  await disconnectPending(pending)
}

/**
 * Tear down and evict every cached adapter. Call on sign-out so no agent
 * connection survives across user identities.
 */
export const disposeAllAdapters = async (): Promise<void> => {
  const pending = [...cache.values()]
  cache.clear()
  await Promise.all(pending.map(disconnectPending))
}

/**
 * Forget every cached entry WITHOUT disconnecting. Use only for test isolation
 * — the chat-store reset hook calls this so cache state never bleeds between
 * tests. Production teardown goes through `disposeAdapter` / `disposeAllAdapters`.
 */
export const clearAdapterCache = (): void => {
  cache.clear()
}
