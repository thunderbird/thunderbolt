/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentProvider } from '@/agents'
import { buildWebSocketUrl } from '@/agents'
import type { Settings } from '@/config/settings'
import type { RemoteAgentDescriptor } from '@shared/acp-types'

/**
 * Provider id registered into the agent discovery registry. Stable: the registry
 * dedupes on it, so re-importing this module never double-registers.
 */
export const codingAgentProviderId = 'coding-agent'

/**
 * Build the coding-agent provider. Surfaces a single `managed-acp` agent whose
 * WS URL points at `/v1/coding-agent/ws` (this backend), which authenticates the
 * developer, provisions their GitHub token, and proxies to the workspace shim.
 *
 * The agent is only advertised when the workspace endpoint is configured
 * (`CODING_AGENT_WORKSPACE_WS_URL`); otherwise the list is empty so a deployment
 * without the coding agent doesn't surface a dead entry. (Per-workspace, per-user
 * discovery is a later increment — today there is one shared workspace endpoint.)
 */
export const createCodingAgentProvider = (): AgentProvider => ({
  id: codingAgentProviderId,
  list: (request: Request, settings: Settings): RemoteAgentDescriptor[] => {
    if (settings.codingAgentWorkspaceWsUrl.trim().length === 0) {
      return []
    }
    return [
      {
        id: codingAgentProviderId,
        name: 'Coding Agent',
        type: 'managed-acp',
        transport: 'websocket',
        url: buildWebSocketUrl(request, '/coding-agent/ws'),
        description: 'Self-hosted Cline agent that codes in a sandboxed workspace and acts as you on GitHub.',
        icon: null,
        isSystem: 1,
      },
    ]
  },
})
