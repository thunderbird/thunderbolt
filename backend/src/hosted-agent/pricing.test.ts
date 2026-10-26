/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { InferencePrice } from '@/inference/usage-ledger'
import { createTestSettings } from '@/test-utils/settings'
import { assertServiceTierPriced, priceForServiceTier } from './pricing'

const priority = createTestSettings({ agentFireworksServiceTier: 'priority' })
const standard = createTestSettings({ agentFireworksServiceTier: 'standard' })

const glmPrice: InferencePrice = {
  provider: 'fireworks',
  model: 'accounts/fireworks/models/glm-5p3',
  inputNanoUsdPerToken: 1400n,
  outputNanoUsdPerToken: 4400n,
  cacheReadNanoUsdPerToken: 261n,
}

describe('priceForServiceTier', () => {
  it('scales every GLM 5.3 rate by 5/4 on priority, rounding down', () => {
    expect(priceForServiceTier(glmPrice, priority)).toEqual({
      ...glmPrice,
      inputNanoUsdPerToken: 1750n,
      outputNanoUsdPerToken: 5500n,
      cacheReadNanoUsdPerToken: 326n,
    })
  })

  it('scales every MiniMax M3 rate by 3/2 on priority', () => {
    const minimaxPrice: InferencePrice = {
      provider: 'fireworks',
      model: 'accounts/fireworks/models/minimax-m3',
      inputNanoUsdPerToken: 300n,
      outputNanoUsdPerToken: 1200n,
      cacheReadNanoUsdPerToken: 60n,
    }
    expect(priceForServiceTier(minimaxPrice, priority)).toEqual({
      ...minimaxPrice,
      inputNanoUsdPerToken: 450n,
      outputNanoUsdPerToken: 1800n,
      cacheReadNanoUsdPerToken: 90n,
    })
  })

  it('leaves a missing cache-read rate missing', () => {
    const { cacheReadNanoUsdPerToken: _, ...withoutCacheRead } = glmPrice
    expect(priceForServiceTier(withoutCacheRead, priority)).toEqual({
      ...withoutCacheRead,
      inputNanoUsdPerToken: 1750n,
      outputNanoUsdPerToken: 5500n,
    })
  })

  it('leaves an Anthropic price alone on priority', () => {
    const anthropicPrice: InferencePrice = {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      inputNanoUsdPerToken: 5000n,
      outputNanoUsdPerToken: 25000n,
    }
    expect(priceForServiceTier(anthropicPrice, priority)).toBe(anthropicPrice)
  })

  it('leaves a Fireworks price alone on standard', () => {
    expect(priceForServiceTier(glmPrice, standard)).toBe(glmPrice)
  })
})

describe('assertServiceTierPriced', () => {
  const unpriced = { provider: 'fireworks', model: 'accounts/fireworks/models/unpriced' } as const

  it('refuses priority on a Fireworks model with no known surcharge, naming the variable and model', () => {
    expect(() => assertServiceTierPriced(unpriced, priority)).toThrow(
      'AGENT_FIREWORKS_SERVICE_TIER is "priority", but the Priority surcharge of AGENT_MODEL ' +
        '"accounts/fireworks/models/unpriced" is unknown',
    )
  })

  it.each([
    ['standard on an unpriced Fireworks model', unpriced, standard],
    ['priority on a known Fireworks model', { provider: 'fireworks', model: glmPrice.model } as const, priority],
    ['priority on Anthropic', { provider: 'anthropic', model: 'claude-opus-5-5' } as const, priority],
  ] as const)('accepts %s', (_, identity, settings) => {
    expect(() => assertServiceTierPriced(identity, settings)).not.toThrow()
  })
})
