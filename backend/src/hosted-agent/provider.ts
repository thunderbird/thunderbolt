/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentProvider } from '@/agents/discovery'

export const hostedAgentId = 'hosted-agent'

/** Same-origin path of the chat endpoint: the `/v1` mount plus the routes' `/agent` prefix and `/chat`. */
export const hostedAgentChatPath = '/v1/agent/chat'

/**
 * Provider for the server-hosted agent served at `POST {@link hostedAgentChatPath}`. Emits a
 * single `managed-http` descriptor when `AGENT_ENABLED` is set and nothing
 * otherwise. The URL is relative so the client resolves it against its own
 * backend origin. It is flagged `anonymousSafe` because the hosted agent is
 * designed to work with zero setup for anonymous visitors.
 */
export const createHostedAgentProvider = (): AgentProvider => ({
  id: hostedAgentId,
  list: (_request, settings) => {
    if (!settings.agentEnabled) {
      return []
    }
    return [
      {
        id: hostedAgentId,
        name: settings.agentName,
        type: 'managed-http',
        transport: 'http',
        url: hostedAgentChatPath,
        description: settings.agentDescription || null,
        icon: settings.agentIcon || null,
        isSystem: 1,
        anonymousSafe: true,
      },
    ]
  },
})
