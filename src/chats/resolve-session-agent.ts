/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { builtInAgent, builtInAgents, zeusAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'

/**
 * What the user has chosen, from synced settings. `lastUsedAgentId` is the
 * `selected_agent` setting. `hasModelPick` is whether `selected_model` is set:
 * only the built-in agent uses the picked model, so a model pick counts as
 * choosing the built-in even when the agent picker was never opened.
 */
export type AgentPreference = {
  lastUsedAgentId?: string | null
  hasModelPick?: boolean
}

/** The agent identity for persisted chats, including the legacy single-agent split. */
export const persistedThreadAgentId = (thread: { agentId?: string | null; isEncrypted: number }): string => {
  if (!thread.agentId || thread.agentId === builtInAgent.id) {
    return thread.isEncrypted === 1 ? builtInAgent.id : zeusAgent.id
  }
  return thread.agentId
}

/** Keeps an unavailable saved agent visible without routing its history elsewhere. */
const unavailableAgent = (id: string): Agent => {
  const builtIn = builtInAgents.find((agent) => agent.id === id)
  if (builtIn) {
    return { ...builtIn, enabled: 0 }
  }
  return {
    id,
    name: id,
    type: 'remote-acp',
    transport: 'websocket',
    url: null,
    description: null,
    icon: null,
    isSystem: 0,
    enabled: 0,
    deletedAt: null,
    userId: null,
  }
}

/**
 * Persisted chats retain their agent even when it is unavailable. New chats use
 * the last deliberate choice, discovery's default, then the first available agent.
 */
export const resolveSessionAgent = (
  allAgents: Agent[],
  candidates: AgentPreference & { threadAgentId?: string | null; discoveredDefaultAgent?: Agent },
): Agent => {
  const findAgent = (agentId: string | null | undefined) =>
    agentId ? allAgents.find((a) => a.id === agentId) : undefined
  if (candidates.threadAgentId) {
    return findAgent(candidates.threadAgentId) ?? unavailableAgent(candidates.threadAgentId)
  }
  return (
    findAgent(candidates.lastUsedAgentId) ??
    (candidates.hasModelPick ? findAgent(builtInAgent.id) : undefined) ??
    findAgent(candidates.discoveredDefaultAgent?.id) ??
    allAgents.find((agent) => agent.enabled === 1 && !agent.deletedAt) ??
    unavailableAgent(builtInAgent.id)
  )
}
