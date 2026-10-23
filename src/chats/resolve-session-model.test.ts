/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelDeepSeekV41Flash, defaultModelGlm53, defaultModelOpus55 } from '@shared/defaults/models'
import { builtInAgent, zeusAgent } from '@/defaults/agents'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import type { Agent } from '@/types/acp'
import { describe, expect, it } from 'bun:test'
import { resolveSessionModel } from './resolve-session-model'

const confidential = createMockModel({
  id: defaultModelDeepSeekV41Flash.id,
  provider: 'tinfoil',
  isSystem: 1,
  isConfidential: 1,
})
const missingKey = createMockModel({ id: defaultModelGlm53.id, provider: 'tinfoil', isSystem: 0, apiKey: null })
const standard = createMockModel({ id: defaultModelOpus55.id, provider: 'thunderbolt', model: 'opus-5-5' })
const models = [missingKey, confidential, standard]

describe('resolveSessionModel', () => {
  it('resolves Thunderbolt to an available Tinfoil model before a thread exists', () => {
    expect(resolveSessionModel(builtInAgent, standard, models).id).toBe(confidential.id)
  })

  it('resolves Zeus to Opus 5.5', () => {
    expect(resolveSessionModel(zeusAgent, confidential, models).id).toBe(standard.id)
  })

  it('does not fall back to custom models when the preconfigured model is unavailable', () => {
    const custom = createMockModel({ id: 'custom', provider: 'custom', model: 'local-model', isConfidential: 0 })
    expect(resolveSessionModel(zeusAgent, confidential, [confidential, custom])).toBe(confidential)
    expect(resolveSessionModel(zeusAgent, custom, [custom, standard])).toBe(standard)
    expect(resolveSessionModel(zeusAgent, confidential, [custom, standard])).toBe(standard)
  })

  it.each([{ enabled: 0 }, { deletedAt: '2026-10-21T00:00:00.000Z' }, { isSystem: 0, apiKey: null }] as const)(
    'skips unavailable preconfigured models: %j',
    (overrides) => {
      const unavailable = { ...confidential, ...overrides }
      const available = createMockModel({ id: defaultModelGlm53.id, model: defaultModelGlm53.model })
      expect(resolveSessionModel(builtInAgent, unavailable, [unavailable, available])).toBe(available)
    },
  )

  it('keeps the current value when no allowed model is available so sending can be blocked', () => {
    expect(resolveSessionModel(zeusAgent, confidential, [confidential])).toBe(confidential)
  })

  it('uses the current model row so refreshed credentials and disabled state take effect', () => {
    const changed = { ...confidential, apiKey: 'changed-key', enabled: 0 }
    expect(resolveSessionModel(builtInAgent, confidential, [changed])).toBe(changed)
  })

  it('disables a removed model when no replacement is available', () => {
    expect(resolveSessionModel(builtInAgent, confidential, [])).toMatchObject({
      id: confidential.id,
      enabled: 0,
    })
  })

  it('leaves the model alone for an agent that does not use it', () => {
    const hostedAgent: Agent = { ...builtInAgent, id: 'hosted-agent', type: 'managed-http', transport: 'http' }
    expect(resolveSessionModel(hostedAgent, confidential, models).id).toBe(confidential.id)
  })

  it('keeps an available model in the agent policy', () => {
    expect(resolveSessionModel(builtInAgent, confidential, models).id).toBe(confidential.id)
  })
})
