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
 * Hand the chat store this refresh's default agent (null when a 401/403 cleared
 * the table, or the response names none), with the refreshed agent list and the
 * user's synced choices, so unstarted chats re-resolve against both.
 */
const syncDiscoveredDefault = async (db: AnyDrizzleDatabase, defaultAgent: Agent | null, signal: AbortSignal) => {
  const includeBuiltIn = selectBuiltInAgentEnabled(useConfigStore.getState().config)
  const [settings, agents] = await Promise.all([
    getSettings(db, { selected_agent: String, selected_model: String }),
    loadAllAgents(db, { includeBuiltIn }),
  ])
  if (signal.aborted) {
    return
  }
  useChatStore.getState().applyDiscoveredDefaultAgent(defaultAgent, agents, {
    lastUsedAgentId: settings.selectedAgent,
    hasModelPick: !!settings.selectedModel,
  })
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

  // Signing in switches the session to a different user id, which re-runs this:
  // a real account sees more agents than an anonymous one.
  const userId = session?.user?.id

  useEffect(() => {
    if (!userId || !cloudUrl) {
      return
    }
    // Signing in re-runs this while the anonymous refresh may still be in flight.
    // Aborting it stops its late response (a 403 that clears the table, or a
    // smaller anonymous list) from overwriting what the signed-in refresh wrote.
    const controller = new AbortController()
    const { signal } = controller
    const run = async () => {
      const result = await refresh(db, httpClient, signal)
      // A refresh that wrote its rows committed before any abort could stop it,
      // so its wire-identity changes apply even if a newer run has started: that
      // run compares against the rows this one wrote and would never see them.
      if (result.refreshed) {
        for (const agent of result.wireIdentityChangedAgents) {
          useChatStore.getState().applyAgentWireIdentityChange(agent)
        }
      }
      if (signal.aborted) {
        return
      }
      if (result.refreshed) {
        await syncDiscoveredDefault(db, result.defaultAgent, signal)
      } else if (result.reason === 'unauthenticated') {
        await syncDiscoveredDefault(db, null, signal)
      }
    }
    run().catch((error) => console.error('Failed to apply agent discovery', error))
    return () => controller.abort()
  }, [userId, cloudUrl, db, httpClient, refresh])
}
