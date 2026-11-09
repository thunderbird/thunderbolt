/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { selectBuiltInAgentEnabled, useConfigStore } from '@/api/config-store'
import { composeAllAgents, type getAllAgents, type getAllSystemAgents } from '@/dal'
import { customRowToAgent, systemRowToAgent } from '@/dal/agents'
import type { Agent } from '@/types/acp'
import { useChatStore } from './chat-store'
import { resolveSessionAgent } from './resolve-session-agent'

type ChatAgentInputs = {
  /** The persisted thread, or null for a brand-new chat. */
  chatThread: { agentId: string | null } | null
  settings: { selectedAgent: string | null; selectedModel: string | null }
  customAgentRows: Awaited<ReturnType<typeof getAllAgents>>
  systemAgentRows: Awaited<ReturnType<typeof getAllSystemAgents>>
}

/**
 * The agent a chat runs on: the thread's own, then the user's last pick, then
 * the deployment's discovered default. Shared by chat hydration and Quick
 * Entry, which has to know before a chat exists whether it will be on the
 * built-in agent (and so whether to offer a model picker).
 *
 * Read the stores after the last await of the caller's reads, so nothing can
 * land between this and the session it seeds.
 */
export const resolveChatAgent = ({
  chatThread,
  settings,
  customAgentRows,
  systemAgentRows,
}: ChatAgentInputs): Agent => {
  // Built-in is implicit (lives in code); the DB rows are only customs + system.
  // Respect the deployment's `disableBuiltInAgent` flag so the resolved agent
  // and the dropdown agree on whether the built-in exists.
  const includeBuiltIn = selectBuiltInAgentEnabled(useConfigStore.getState().config)
  const allAgents = composeAllAgents(systemAgentRows.map(systemRowToAgent), customAgentRows.map(customRowToAgent), {
    includeBuiltIn,
  })
  // Only a brand-new chat takes the discovered default; a persisted thread with
  // no agent of its own stays on the fallback chain. Once discovery has
  // answered, its result wins over `agents_system` rows read before it wrote or
  // cleared them; until then the cached `is_default` row stands in.
  const { agentDiscovery } = useChatStore.getState()
  const discoveredDefaultRowId = systemAgentRows.find((row) => row.isDefault === 1)?.id
  const discoveredDefaultAgent = chatThread
    ? undefined
    : agentDiscovery.status === 'done'
      ? (agentDiscovery.defaultAgent ?? undefined)
      : allAgents.find((agent) => agent.id === discoveredDefaultRowId)
  // A finished discovery's own list covers agents its write added after the read above.
  const knownAgents =
    agentDiscovery.status === 'done'
      ? [...allAgents, ...agentDiscovery.agents.filter((agent) => !allAgents.some(({ id }) => id === agent.id))]
      : allAgents
  return resolveSessionAgent(knownAgents, {
    threadAgentId: chatThread?.agentId,
    lastUsedAgentId: settings.selectedAgent,
    hasModelPick: !!settings.selectedModel,
    discoveredDefaultAgent,
  })
}
