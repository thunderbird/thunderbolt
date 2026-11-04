/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { createTestSettings } from '@/test-utils/settings'
import { generateText } from 'ai'
import { createAgentModel, getAgentIdentity } from './model'

describe('getAgentIdentity', () => {
  it.each([
    ['accounts/fireworks/models/glm-5p3', 'fireworks'],
    ['accounts/fireworks/models/minimax-m3', 'fireworks'],
    ['claude-opus-5-5', 'anthropic'],
  ] as const)('runs %s on %s', (model, provider) => {
    expect(getAgentIdentity(model)).toEqual({ provider, model })
  })

  it('names the id, both supported shapes and the supported ids when it refuses', () => {
    expect(() => getAgentIdentity('accounts/acme/models/glm-5p3')).toThrow(
      'AGENT_MODEL "accounts/acme/models/glm-5p3" is not a hosted-agent model. Use a Fireworks serverless id ' +
        '(accounts/fireworks/models/<name>) or a bare Anthropic id, one of: accounts/fireworks/models/glm-5p3, ' +
        'accounts/fireworks/models/minimax-m3, claude-opus-5-5. Fireworks models in other accounts are not supported yet.',
    )
  })
})

describe('createAgentModel service tier', () => {
  const upstreamBody = async (model: string, tier: 'standard' | 'priority') => {
    const fetchFn = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ error: { message: 'stub' } }, { status: 400 }),
    )
    const settings = createTestSettings({
      fireworksApiKey: 'fw-key',
      anthropicApiKey: 'an-key',
      agentFireworksServiceTier: tier,
    })
    const languageModel = createAgentModel(getAgentIdentity(model), settings, {
      fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
    })
    await generateText({ model: languageModel, prompt: 'Hi', maxRetries: 0 }).catch(() => undefined)
    return JSON.parse(String(fetchFn.mock.calls[0][1]?.body))
  }

  const fireworksModel = 'accounts/fireworks/models/glm-5p3'

  it('asks Fireworks for the priority tier', async () => {
    expect((await upstreamBody(fireworksModel, 'priority')).service_tier).toBe('priority')
  })

  it('sends no service_tier on standard', async () => {
    expect(await upstreamBody(fireworksModel, 'standard')).not.toHaveProperty('service_tier')
  })

  it('leaves the Anthropic request alone on priority', async () => {
    expect(await upstreamBody('claude-opus-5-5', 'priority')).not.toHaveProperty('service_tier')
  })
})
