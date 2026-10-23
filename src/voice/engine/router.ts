/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Agent } from '@/types/acp'
import { isAgentVoiceConfigured } from '../agent-voice'
import { createThunderboltEngine } from './thunderbolt-engine'
import type { VoiceEngine } from './types'

/** Route speech through the chat's agent, never through a global provider override. */
export const createVoiceEngine = (agent: Agent): VoiceEngine => {
  if (!isAgentVoiceConfigured(agent.voice)) {
    throw new Error(`Voice is not configured for agent "${agent.id}"`)
  }
  return createThunderboltEngine(agent.voice)
}
