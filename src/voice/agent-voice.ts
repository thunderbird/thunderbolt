/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Agent, AgentVoiceConfig } from '@/types/acp'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

/** Voice models are configured by the agent; an incomplete provider never falls back. */
export const isAgentVoiceConfigured = (
  voice: AgentVoiceConfig | undefined,
): voice is Extract<AgentVoiceConfig, { provider: 'tinfoil' }> => voice?.provider === 'tinfoil'

/** Explain unavailable voice without loading the audio runtime into the composer. */
export const agentVoiceUnavailableMessage = (agent: Agent): MessageDescriptor | null => {
  if (isAgentVoiceConfigured(agent.voice)) {
    return null
  }
  return agent.voice ? msg`Voice is not configured for this agent yet.` : msg`Voice is not available for this agent.`
}
