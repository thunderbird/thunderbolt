/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Agent } from '@/types/acp'

/**
 * Human label for where an ACP agent lives: the endpoint host for WebSocket
 * agents, or a generic peer label for iroh targets (a bare NodeId / ticket is
 * not a URL and is too long to display). Never throws in render.
 */
export const acpEndpointLabel = (agent: Pick<Agent, 'transport' | 'url'>): string => {
  if (agent.transport === 'iroh') {
    return 'iroh peer'
  }
  if (!agent.url) {
    return ''
  }
  try {
    return new URL(agent.url).host
  } catch {
    return agent.url
  }
}

/**
 * Secondary provenance line for an agent row and the detail-header subtitle.
 * Tells the user where the agent came from; both surfaces read the same
 * string so the row and the detail never drift.
 */
export const agentProvenanceLine = (agent: Agent): string => {
  if (agent.type === 'built-in') {
    return 'Your agent · built into the app'
  }
  if (agent.isSystem === 1) {
    return 'System agent · always available'
  }
  return `Connected agent · ${acpEndpointLabel(agent)}`
}
