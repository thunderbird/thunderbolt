/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { builtInAgent } from '@/defaults/agents'
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

/**
 * Pick the agent a chat session opens on. A persisted thread keeps its own
 * agent. When that no longer resolves (a new chat, a deleted custom, an
 * unsynced system agent, or a built-in the deployment disabled), prefer the
 * user's last-used agent, then the built-in when the user picked a model, so a
 * deliberate choice survives, then the agent the backend's discovery names as
 * default, so a first-time visitor lands on it, then the first available agent,
 * silently, so enterprise users who never had the built-in just continue with
 * their own agent. `builtInAgent` is the last-resort safety net for the
 * degenerate zero-agent deployment.
 *
 * Callers pass `discoveredDefaultAgent` for a brand-new chat only: a persisted
 * thread with no agent of its own (automation runs, threads from before
 * `agent_id` existed) stays on the fallback chain. It is taken only when it is
 * one of `allAgents`, so a stale default from another account or server falls
 * through.
 *
 * A private thread (`privateThread`) opens on the built-in agent before its own.
 * `agent_id` syncs in plaintext, so the server could point the thread at any
 * configured agent, and every agent but the built-in receives the chat
 * unencrypted. Moving it elsewhere again goes through the header's
 * confirmation.
 */
export const resolveSessionAgent = (
  allAgents: Agent[],
  candidates: AgentPreference & {
    threadAgentId?: string | null
    privateThread?: boolean
    discoveredDefaultAgent?: Agent
  },
): Agent => {
  const findAgent = (agentId: string | null | undefined) =>
    agentId ? allAgents.find((a) => a.id === agentId) : undefined
  return (
    (candidates.privateThread ? findAgent(builtInAgent.id) : undefined) ??
    findAgent(candidates.threadAgentId) ??
    findAgent(candidates.lastUsedAgentId) ??
    (candidates.hasModelPick ? findAgent(builtInAgent.id) : undefined) ??
    findAgent(candidates.discoveredDefaultAgent?.id) ??
    allAgents[0] ??
    builtInAgent
  )
}
