/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { builtInAgent, zeusAgent } from '@/defaults/agents'
import { i18n } from '@lingui/core'
import { describe, expect, it } from 'bun:test'
import { agentVoiceUnavailableMessage, isAgentVoiceConfigured } from './agent-voice'

describe('agent voice availability', () => {
  it('allows the current Tinfoil voice configuration', () => {
    expect(isAgentVoiceConfigured(builtInAgent.voice)).toBe(true)
    expect(agentVoiceUnavailableMessage(builtInAgent)).toBeNull()
  })

  it('explains that Zeus is waiting for model selection', () => {
    expect(isAgentVoiceConfigured(zeusAgent.voice)).toBe(false)
    expect(i18n._(agentVoiceUnavailableMessage(zeusAgent)!)).toBe('Voice is not configured for this agent yet.')
  })

  it('marks agents without voice configuration as unsupported', () => {
    expect(isAgentVoiceConfigured(undefined)).toBe(false)
    expect(i18n._(agentVoiceUnavailableMessage({ ...builtInAgent, voice: undefined })!)).toBe(
      'Voice is not available for this agent.',
    )
  })
})
