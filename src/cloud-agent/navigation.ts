/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Derive cloud navigation from the URL so browser history restores the same surface. */
export const cloudAgentRoute = (search: URLSearchParams) => {
  const oauth = search.get('cloudOAuth')
  const oauthResult = oauth === 'connected' || oauth === 'failed' ? oauth : null
  const artifactId = search.get('artifact')
  const agentId = artifactId ? null : search.get('agent')
  const tab = artifactId
    ? 'artifacts'
    : agentId
      ? 'agents'
      : oauthResult || search.get('tab') === 'connections'
        ? 'connections'
        : search.get('tab') === 'artifacts'
          ? 'artifacts'
          : 'agents'
  return {
    tab,
    oauthResult,
    agentId,
    artifactId,
    conversationId: agentId ? search.get('conversation') : null,
    creating: tab === 'agents' && !agentId && search.get('create') === 'agent',
    editing: tab === 'agents' && !!agentId && search.get('edit') === 'agent',
  } as const
}

/** Cloud conversations reuse their UUID as the ordinary chat thread ID. */
export const cloudConversationLocation = (agentId: string, conversationId: string) =>
  `/chats/${encodeURIComponent(conversationId)}?cloudAgent=${encodeURIComponent(agentId)}`

/** Preserve existing links while each resource moves to its ordinary product surface. */
export const legacyCloudAgentLocation = (search: URLSearchParams) => {
  const route = cloudAgentRoute(search)
  const next = new URLSearchParams()
  if (route.tab === 'artifacts') {
    if (route.artifactId) {
      next.set('artifact', route.artifactId)
    }
    return `/artifacts${next.size ? `?${next}` : ''}`
  }
  if (route.tab === 'connections') {
    if (route.oauthResult) {
      next.set('cloudOAuth', route.oauthResult)
    }
    return `/settings/connections${next.size ? `?${next}` : ''}`
  }
  if (route.agentId && route.conversationId) {
    return cloudConversationLocation(route.agentId, route.conversationId)
  }
  if (route.creating) {
    next.set('create', 'agent')
  }
  if (route.agentId) {
    next.set('agent', route.agentId)
  }
  return `/settings/agents${next.size ? `?${next}` : ''}`
}
