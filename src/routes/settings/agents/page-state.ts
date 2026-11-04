/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cloudConversationLocation } from '@/cloud-agent/navigation'
import type { AgentDetailView } from '@/components/settings/agents/cloud-agent-detail'

export type AgentPanel = { kind: 'add' } | { kind: 'agent'; id: string } | { kind: 'cli' } | null

/** Keep all agent environments in the same URL-addressable aside. */
export const agentPageState = (search: URLSearchParams) => {
  const id = search.get('agent')
  const panel: AgentPanel =
    search.get('create') === 'agent'
      ? { kind: 'add' }
      : id
        ? { kind: 'agent', id }
        : search.get('cli') === '1'
          ? { kind: 'cli' }
          : null
  const view: AgentDetailView = search.get('view') === 'schedules' ? 'schedules' : 'settings'
  return { panel, view }
}

/** Selecting another agent starts on its settings, without unrelated route state. */
export const agentPanelSearch = (panel: AgentPanel) => {
  const search = new URLSearchParams()
  if (panel?.kind === 'agent') {
    search.set('agent', panel.id)
  }
  if (panel?.kind === 'add') {
    search.set('create', 'agent')
  }
  if (panel?.kind === 'cli') {
    search.set('cli', '1')
  }
  return search
}

/** Translate palette intents into the same persistent selection as row clicks. */
export const agentActionPanel = (state: unknown): AgentPanel | undefined => {
  if (!state || typeof state !== 'object' || !('agentsAction' in state) || typeof state.agentsAction !== 'string') {
    return undefined
  }
  try {
    const intent: unknown = JSON.parse(state.agentsAction)
    if (!intent || typeof intent !== 'object' || !('type' in intent)) {
      return null
    }
    if (intent.type === 'create') {
      return { kind: 'add' }
    }
    if (intent.type === 'edit' && 'id' in intent && typeof intent.id === 'string') {
      return { kind: 'agent', id: intent.id }
    }
    return null
  } catch {
    return null
  }
}

/** Move existing conversation bookmarks to the ordinary chat flow instead of reopening an agent aside. */
export const agentConversationRedirect = (search: URLSearchParams): string | null => {
  const agentId = search.get('agent')
  const conversationId = search.get('conversation')
  return agentId && conversationId ? cloudConversationLocation(agentId, conversationId) : null
}
