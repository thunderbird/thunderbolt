/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { getSettings } from '@/dal'
import { loadAllAgents } from '@/dal/agents'
import { selectBuiltInAgentEnabled, useConfigStore } from '@/api/config-store'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { refreshSystemAgents } from '@/db/seeding/seed-agents'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { Agent } from '@/types/acp'
import { useEffect } from 'react'

type UseBootstrapSystemAgentsOptions = {
  /** Test seam for the discovery refresh. */
  refresh?: typeof refreshSystemAgents
}

/**
 * Hand the chat store this refresh's default agent. With none (a 401/403 cleared
 * the table, or the response names no default), unstarted chats still on the old
 * default go back through the fallback chain instead.
 */
const syncDiscoveredDefault = async (db: AnyDrizzleDatabase, defaultAgent: Agent | null, signal: AbortSignal) => {
  const { selectedAgent } = await getSettings(db, { selected_agent: String })
  if (defaultAgent) {
    if (!signal.aborted) {
      useChatStore.getState().applyDiscoveredDefaultAgent(defaultAgent, selectedAgent)
    }
    return
  }
  const includeBuiltIn = selectBuiltInAgentEnabled(useConfigStore.getState().config)
  const agents = await loadAllAgents(db, { includeBuiltIn })
  if (!signal.aborted) {
    useChatStore.getState().clearDiscoveredDefaultAgent(agents, selectedAgent)
  }
}

/**
 * Hydrate the local-only `agents_system` table from the backend's `/agents`
 * discovery endpoint whenever there is a session. Anonymous sessions included:
 * the backend answers them with its `anonymousSafe` agents, or a 403 that clears
 * the table.
 *
 * Legitimate `useEffect` per CLAUDE.md guidance: synchronizing app state with
 * an external system (the backend) on auth/cloud-URL transitions. There is no
 * render-time computation that could replace this: the fetch must run as a
 * side effect when the gating conditions flip, and PowerSync's reactive query
 * picks up the resulting rows automatically.
 */
export const useBootstrapSystemAgents = ({ refresh = refreshSystemAgents }: UseBootstrapSystemAgentsOptions = {}) => {
  const db = useDatabase()
  const httpClient = useHttpClient()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)

  // Re-run when the visitor signs in, since a real account sees more agents than an anonymous one.
  const userId = session?.user?.id
  const isAnonymous = session?.user?.isAnonymous === true

  useEffect(() => {
    if (!userId || !cloudUrl) {
      return
    }
    // Signing in re-runs this while the anonymous refresh may still be in flight.
    // Aborting it stops its late response (a 403 that clears the table, or a
    // smaller anonymous list) from overwriting what the signed-in refresh wrote.
    const controller = new AbortController()
    const { signal } = controller
    void (async () => {
      const result = await refresh(db, httpClient, signal)
      if (signal.aborted) {
        return
      }
      if (result.refreshed) {
        for (const agent of result.wireIdentityChangedAgents) {
          useChatStore.getState().applyAgentWireIdentityChange(agent)
        }
        await syncDiscoveredDefault(db, result.defaultAgent, signal)
      } else if (result.reason === 'unauthenticated') {
        await syncDiscoveredDefault(db, null, signal)
      }
    })()
    return () => controller.abort()
  }, [userId, isAnonymous, cloudUrl, db, httpClient, refresh])
}
