/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { defaultModelDeepSeekV41Flash, defaultModelGlm53, defaultModelOpus55 } from '@shared/defaults/models'
import { builtInAgent, builtInAgents, isModelAllowedForAgent, isPrivateAgent, zeusAgent } from './agents'

describe('built-in agents', () => {
  it('ships private Vesta first and non-private Zeus second', () => {
    expect(builtInAgents.map((agent) => agent.name)).toEqual(['Vesta', 'Zeus'])
    expect(isPrivateAgent(builtInAgent)).toBe(true)
    expect(isPrivateAgent(zeusAgent)).toBe(false)
    expect(isPrivateAgent({ ...builtInAgent, isPrivate: undefined })).toBe(false)
    expect(isPrivateAgent({ ...builtInAgent, type: 'remote-acp' })).toBe(false)
    expect(isPrivateAgent({ ...builtInAgent, type: 'managed-http' })).toBe(false)
    expect(isPrivateAgent({ ...zeusAgent, isPrivate: true })).toBe(false)
  })

  it('allows only the preconfigured Tinfoil models for Vesta', () => {
    expect(isModelAllowedForAgent(builtInAgent, defaultModelDeepSeekV41Flash)).toBe(true)
    expect(isModelAllowedForAgent(builtInAgent, defaultModelGlm53)).toBe(true)
    expect(isModelAllowedForAgent(builtInAgent, defaultModelOpus55)).toBe(false)
    expect(isModelAllowedForAgent(builtInAgent, { ...defaultModelDeepSeekV41Flash, provider: 'custom' })).toBe(false)
    expect(isModelAllowedForAgent(builtInAgent, { ...defaultModelDeepSeekV41Flash, model: 'other-model' })).toBe(false)
  })

  it('allows only hosted Opus 5.5 for Zeus', () => {
    expect(isModelAllowedForAgent(zeusAgent, defaultModelOpus55)).toBe(true)
    expect(isModelAllowedForAgent(zeusAgent, defaultModelGlm53)).toBe(false)
    expect(isModelAllowedForAgent(zeusAgent, { ...defaultModelOpus55, provider: 'custom' })).toBe(false)
    expect(isModelAllowedForAgent(zeusAgent, { ...defaultModelOpus55, provider: 'openai' })).toBe(false)
    expect(isModelAllowedForAgent(zeusAgent, { ...defaultModelOpus55, provider: 'anthropic' })).toBe(false)
    expect(isModelAllowedForAgent(zeusAgent, { ...defaultModelOpus55, model: 'other-model' })).toBe(false)
  })

  it('leaves remote model selection to the agent and rejects unknown built-ins', () => {
    expect(isModelAllowedForAgent({ ...builtInAgent, type: 'remote-acp' }, defaultModelOpus55)).toBe(true)
    expect(isModelAllowedForAgent({ ...builtInAgent, id: 'unknown' }, defaultModelOpus55)).toBe(false)
  })

  it('defines Tinfoil voice models on Vesta and pending Fireworks models on Zeus', () => {
    expect(builtInAgent.voice).toEqual({
      provider: 'tinfoil',
      sttModel: 'whisper-large-v3-turbo',
      ttsModel: 'qwen3-tts',
      ttsVoice: 'ryan',
    })
    expect(zeusAgent.voice).toEqual({ provider: 'fireworks', sttModel: null, ttsModel: null, ttsVoice: null })
  })
})
