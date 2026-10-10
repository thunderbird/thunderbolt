/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { builtInAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'

/**
 * Pick the agent a chat session opens on. A persisted thread keeps its own
 * agent. When that no longer resolves (a new chat, a deleted custom, an
 * unsynced system agent, or a built-in the deployment disabled), prefer the
 * user's last-used agent (the global `selected_agent` setting), so a deliberate
 * pick survives, then the agent the backend's discovery names as default, so a
 * first-time visitor lands on it, then the first available agent, silently,
 * so enterprise users who never had the built-in just continue with their own
 * agent. `builtInAgent` is the last-resort safety net for the
 * degenerate zero-agent deployment.
 */
export const resolveSessionAgent = (
  allAgents: Agent[],
  candidates: { threadAgentId?: string | null; lastUsedAgentId?: string | null; discoveredDefaultAgent?: Agent },
): Agent => {
  const findAgent = (agentId: string | null | undefined) =>
    agentId ? allAgents.find((a) => a.id === agentId) : undefined
  return (
    findAgent(candidates.threadAgentId) ??
    findAgent(candidates.lastUsedAgentId) ??
    candidates.discoveredDefaultAgent ??
    allAgents[0] ??
    builtInAgent
  )
}
