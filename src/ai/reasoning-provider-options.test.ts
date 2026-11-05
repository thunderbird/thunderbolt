/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { JSONValue } from 'ai'
import { reasoningProviderOptions } from './reasoning-provider-options'

describe('legacy reasoning provider options', () => {
  it('preserves OpenRouter output preferences while replacing conflicting budgets', () => {
    const profile = {
      reasoning: { exclude: true, max_tokens: 1000, enabled: false },
      reasoningEffort: 'low',
      user: 'test',
    }
    expect(reasoningProviderOptions(profile, 'openrouter', 'high', false)).toEqual({
      user: 'test',
      reasoning: { exclude: true, effort: 'high' },
    })
    expect(profile.reasoning.max_tokens).toBe(1000)
  })
  it.each([null, false, ['high']] as JSONValue[])('replaces non-object reasoning configuration (%j)', (reasoning) => {
    expect(reasoningProviderOptions({ reasoning }, 'openrouter', 'none', false)).toEqual({
      reasoning: { effort: 'none' },
    })
  })
  it('uses the SDK camel-case key for OpenAI and removes stale alternative controls', () => {
    expect(
      reasoningProviderOptions(
        { thinking: { type: 'enabled' }, reasoning_effort: 'high', effort: 'high', user: 'test' },
        'openai',
        'none',
        false,
      ),
    ).toEqual({ user: 'test', reasoningEffort: 'none' })
  })
  it.each([
    ['none', false, { thinking: { type: 'disabled' } }],
    ['high', true, { thinking: { type: 'enabled', budgetTokens: 4096 } }],
    ['max', false, { thinking: { type: 'adaptive' }, effort: 'max' }],
  ] as const)('translates Anthropic %s with budget-only=%s', (effort, budgetOnly, expected) => {
    expect(reasoningProviderOptions({}, 'anthropic', effort, budgetOnly)).toEqual(expected)
  })
})
