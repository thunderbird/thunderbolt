/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { builtInAgent, zeusAgent } from '@/defaults/agents'
import { defaultVoiceProvider, useLocalSettingsStore } from '@/stores/local-settings-store'
import { afterEach, describe, expect, it } from 'bun:test'
import { createVoiceEngine } from './router'

describe('createVoiceEngine', () => {
  afterEach(() => {
    useLocalSettingsStore.getState().setLocalSetting('voiceProvider', defaultVoiceProvider)
  })

  it('keeps Thunderbolt on its attested engine despite a legacy custom provider override', () => {
    useLocalSettingsStore.getState().setLocalSetting('voiceProvider', {
      ...defaultVoiceProvider,
      kind: 'openai-compatible',
      baseUrl: 'https://external.example/v1',
    })

    const engine = createVoiceEngine(builtInAgent)
    expect(engine.id).toBe('thunderbolt')
    engine.dispose()
  })

  it('refuses Zeus voice until its Fireworks models are selected', () => {
    expect(() => createVoiceEngine(zeusAgent)).toThrow('Voice is not configured')
  })

  it('does not give an agent without voice configuration a fallback engine', () => {
    expect(() => createVoiceEngine({ ...builtInAgent, id: 'custom-agent', voice: undefined })).toThrow(
      'Voice is not configured',
    )
  })
})
