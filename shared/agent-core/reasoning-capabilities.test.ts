/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai'
import { piReasoningCapabilities } from './reasoning-capabilities'

const model = (overrides: Partial<Model<Api>> = {}): Model<Api> => ({
  id: 'test',
  name: 'Test',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'https://test.invalid',
  reasoning: true,
  input: ['text'],
  contextWindow: 100_000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...overrides,
})

describe('Pi effort discovery', () => {
  it('does not advertise reasoning for unknown or nonreasoning models', () => {
    expect(piReasoningCapabilities(undefined).efforts).toEqual([])
    expect(piReasoningCapabilities(model({ reasoning: false })).efforts).toEqual([])
  })
  it('filters unsupported and aliased levels, including mandatory reasoning', () => {
    const capabilities = piReasoningCapabilities(
      model({
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: 'low',
          medium: 'high',
          high: 'high',
          xhigh: 'high',
          max: 'max',
        },
      }),
    )
    expect(capabilities.efforts).toEqual(['low', 'high', 'max'])
  })
  it('distinguishes an explicit supported off value from omission', () => {
    expect(piReasoningCapabilities(model({ thinkingLevelMap: { off: 'none' } })).efforts).toContain('none')
    expect(piReasoningCapabilities(model()).efforts).not.toContain('none')
  })
  it('omits the implicit minimal-to-low alias on adaptive Anthropic models', () => {
    expect(
      piReasoningCapabilities(model({ api: 'anthropic-messages', compat: { forceAdaptiveThinking: true } })).efforts,
    ).toEqual(['none', 'low', 'medium', 'high'])
  })
  it('uses a toggle for Anthropic budget-only thinking instead of inventing native efforts', () => {
    expect(piReasoningCapabilities(model({ api: 'anthropic-messages' }))).toEqual({
      kind: 'toggle',
      efforts: ['none', 'high'],
    })
  })
})
