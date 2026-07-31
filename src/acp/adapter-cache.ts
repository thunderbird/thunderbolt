/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Global per-agent adapter slots. A terminated generation is rebuilt as a
 * complete transport + ACP connection + initialize handshake, never by swapping
 * a transport underneath live JSON-RPC state. */

import type { Agent, AgentAdapter } from '@/types/acp'
import { useChatStore } from '@/chats/chat-store'
import { AdapterSlot } from './adapter-slot'
import { useAgentCommandsStore } from './agent-commands-store'
import type { connectToAgent as defaultConnectToAgent, ConnectToAgentContext, ConnectToAgentDeps } from './connect'
import { reconnectScheduler, type ReconnectSchedulerLike } from './reconnect-scheduler'
import { getTransportTermination } from './termination'

type AdapterCacheEntry = {
  connect: () => Promise<AgentAdapter>
  scheduler: ReconnectSchedulerLike
  slot: AdapterSlot<AgentAdapter>
}

const cache = new Map<string, AdapterCacheEntry>()

/** Preload the agent connection pipeline before the user's first send. */
export const preloadAgentConnection = (): void => {
  void import('./connect')
}

/** DI seams for connection and reconnect scheduling tests. */
export type AdapterCacheDeps = {
  connectToAgent?: typeof defaultConnectToAgent
  reconnectScheduler?: ReconnectSchedulerLike
}

/** Load the connect chunk on demand and open one complete adapter generation. */
const lazilyConnectToAgent = async (
  agent: Agent,
  context: ConnectToAgentContext,
  deps: ConnectToAgentDeps,
): Promise<AgentAdapter> => {
  const { connectToAgent } = await import('./connect')
  return connectToAgent(agent, context, deps)
}

const createConnect = (
  agent: Agent,
  context: ConnectToAgentContext,
  deps: AdapterCacheDeps & ConnectToAgentDeps,
): (() => Promise<AgentAdapter>) => {
  if (!deps.connectToAgent) {
    return () => lazilyConnectToAgent(agent, context, deps)
  }
  const connectToAgent = deps.connectToAgent
  return () => connectToAgent(agent, context, deps)
}

const createEntry = (
  agent: Agent,
  connect: () => Promise<AgentAdapter>,
  scheduler: ReconnectSchedulerLike,
): AdapterCacheEntry => {
  const entry: AdapterCacheEntry = {
    connect,
    scheduler,
    slot: new AdapterSlot({
      onTerminated: (termination) => {
        if (cache.get(agent.id) !== entry) {
          return
        }
        useAgentCommandsStore.getState().clearCommands(agent.id)
        useChatStore.getState().cancelPendingPermissionsForAgent(agent.id)
        console.warn('ACP adapter generation terminated', agent.id, termination.error)
        const cause = getTransportTermination(termination.error)
        if (cause?.retryable === false) {
          console.error(
            'ACP adapter terminated with a non-retryable error; skipping background reconnect',
            agent.id,
            cause.message,
          )
          return
        }
        entry.scheduler.register(agent.id, async () => {
          await entry.slot.getOrConnect(entry.connect)
        })
      },
    }),
  }
  return entry
}

/** Return the ready generation or join one atomic rebuild for this agent. */
export const getOrConnectAdapter = async (
  agent: Agent,
  context: ConnectToAgentContext,
  deps: AdapterCacheDeps & ConnectToAgentDeps = {},
): Promise<AgentAdapter> => {
  const connect = createConnect(agent, context, deps)
  const existing = cache.get(agent.id)
  const entry = existing ?? createEntry(agent, connect, deps.reconnectScheduler ?? reconnectScheduler)
  entry.connect = connect
  if (!existing) {
    cache.set(agent.id, entry)
  }

  const adapter = await entry.slot.getOrConnect(connect)
  // A generation whose `closed` settled before this continuation resumed has
  // already re-registered its own recovery via onTerminated (status flipped to
  // 'terminated') — only a still-live slot may cancel pending recovery work.
  if (entry.slot.status === 'ready') {
    entry.scheduler.unregister(agent.id)
  }
  return adapter
}

/** Trigger an immediate coalesced background rebuild for a terminated agent. */
export const wakeAdapterReconnect = (agentId: string): void => {
  cache.get(agentId)?.scheduler.wake(agentId)
}

/** Tear down and evict one agent's entire adapter slot. */
export const disposeAdapter = async (agentId: string): Promise<void> => {
  const entry = cache.get(agentId)
  if (!entry) {
    return
  }
  cache.delete(agentId)
  entry.scheduler.unregister(agentId)
  useAgentCommandsStore.getState().clearCommands(agentId)
  // Slot disposal suppresses the onTerminated callback, so the permission
  // cleanup that termination normally performs must happen here too.
  useChatStore.getState().cancelPendingPermissionsForAgent(agentId)
  await entry.slot.dispose()
}

/** Tear down and evict every adapter slot. */
export const disposeAllAdapters = async (): Promise<void> => {
  const entries = [...cache.entries()]
  cache.clear()
  const { clearCommands } = useAgentCommandsStore.getState()
  const { cancelPendingPermissionsForAgent } = useChatStore.getState()
  await Promise.all(
    entries.map(async ([agentId, entry]) => {
      entry.scheduler.unregister(agentId)
      clearCommands(agentId)
      cancelPendingPermissionsForAgent(agentId)
      await entry.slot.dispose()
    }),
  )
}

/** Forget cache state without disconnecting; tests only. */
export const clearAdapterCache = (): void => {
  for (const [agentId, entry] of cache) {
    entry.scheduler.unregister(agentId)
  }
  cache.clear()
}
