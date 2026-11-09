/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  applyReasoningEffort,
  piThinkingLevels,
  reasoningEfforts,
  openRouterReasoningCapabilities,
  reasoningEffortSettingKey,
  preferredReasoningEffort,
  reasoningEffortFormat,
  resolveReasoningEffort,
} from './reasoning-effort'

describe('reasoning capabilities', () => {
  it('keeps Pi levels ordered while distinguishing off from the native none value', () => {
    expect(piThinkingLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(piThinkingLevels).not.toContain('none')
    expect(reasoningEfforts).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(reasoningEfforts).not.toContain('off')
  })
  it('does not invent levels for unknown or non-reasoning models', () => {
    expect(openRouterReasoningCapabilities(undefined).efforts).toEqual([])
    expect(openRouterReasoningCapabilities({}).efforts).toEqual([])
  })
  it('distinguishes the gateway wildcard from an omitted effort list', () => {
    expect(openRouterReasoningCapabilities({ supported_efforts: null }).efforts).toContain('max')
    expect(
      openRouterReasoningCapabilities({ supported_efforts: ['high', 'none', 'unknown'], mandatory: true }).efforts,
    ).toEqual(['high'])
  })
  it('omits unsupported saved values and isolates conversation/model preferences', () => {
    const capabilities = { efforts: ['low', 'high', 'max'] as const }
    expect(resolveReasoningEffort('none', capabilities)).toBeUndefined()
    expect(resolveReasoningEffort('default', capabilities)).toBeUndefined()
    expect(resolveReasoningEffort('high', capabilities)).toBe('high')
    expect(reasoningEffortSettingKey('a', 'm')).not.toBe(reasoningEffortSettingKey('b', 'm'))
    expect(reasoningEffortSettingKey('a', 'm')).not.toBe(reasoningEffortSettingKey('a', 'n'))
  })
  it('defaults only to supported levels and preserves an explicit off choice', () => {
    expect(preferredReasoningEffort(undefined, { efforts: ['none', 'low', 'medium', 'high'] })).toBe('medium')
    expect(preferredReasoningEffort(undefined, { efforts: ['low', 'high', 'max'] })).toBe('high')
    expect(preferredReasoningEffort(undefined, { kind: 'toggle', efforts: ['none', 'high'] })).toBe('high')
    expect(preferredReasoningEffort(undefined, { efforts: ['none', 'low', 'max'] })).toBe('low')
    expect(preferredReasoningEffort(undefined, { efforts: ['none'] })).toBe('none')
    expect(preferredReasoningEffort('none', { efforts: ['none', 'medium', 'high'] })).toBe('none')
    expect(preferredReasoningEffort('max', { efforts: ['low', 'medium'] })).toBe('medium')
    expect(preferredReasoningEffort('high', { efforts: [] })).toBeUndefined()
  })
  it.each(reasoningEfforts)('preserves the supported saved choice %s', (effort) => {
    expect(preferredReasoningEffort(effort, { efforts: reasoningEfforts })).toBe(effort)
  })
  it.each([undefined, null, '', 'default', 'off', 'unknown', 0, false, {}])(
    'uses a supported default for absent or invalid preferences: %j',
    (value) => {
      expect(preferredReasoningEffort(value, { efforts: ['none', 'medium', 'high'] })).toBe('medium')
      expect(preferredReasoningEffort(value, { efforts: [] })).toBeUndefined()
    },
  )
})

describe('effort wire translation', () => {
  it('leaves Default exactly unchanged, including profile configuration', () => {
    const payload = { reasoning_effort: 'low', chat_template_kwargs: { thinking: true } }
    expect(applyReasoningEffort(payload, undefined, 'tinfoil')).toBe(payload)
  })
  it('sends explicit off, rather than confusing it with omission', () => {
    expect(applyReasoningEffort({ model: 'm' }, 'none', 'openai')).toEqual({ model: 'm', reasoning_effort: 'none' })
  })
  it('uses nested OpenRouter effort without conflicting budgets or enable flags', () => {
    const payload = { reasoning_effort: 'low', reasoning: { max_tokens: 100, enabled: false, summary: 'auto' } }
    expect(applyReasoningEffort(payload, 'high', 'openrouter')).toEqual({
      reasoning: { summary: 'auto', effort: 'high' },
    })
    expect(payload.reasoning.max_tokens).toBe(100)
  })
  it('removes empty Tinfoil thinking overrides without mutating the profile', () => {
    const payload = { chat_template_kwargs: { enable_thinking: false, reasoning_effort: 'low' } }
    expect(applyReasoningEffort(payload, 'max', 'tinfoil')).toEqual({ reasoning_effort: 'max' })
    expect(payload.chat_template_kwargs.enable_thinking).toBe(false)
  })
  it.each([{ payload: null }, { payload: [] }, { payload: 'invalid' }])(
    'rejects a malformed provider payload when applying an explicit choice (%j)',
    ({ payload }) => {
      expect(() => applyReasoningEffort(payload, 'high', 'openai')).toThrow('Expected a provider request object')
      expect(applyReasoningEffort(payload, undefined, 'openai')).toBe(payload)
    },
  )
  it('does not silently remap Tinfoil high/max and preserves unrelated template parameters', () => {
    const payload = {
      reasoning_effort: 'xhigh',
      thinking: { type: 'enabled' },
      chat_template_kwargs: { thinking: true, reasoning_effort: 'xhigh', custom: 'keep' },
    }
    expect(applyReasoningEffort(payload, 'high', 'tinfoil')).toEqual({
      reasoning_effort: 'high',
      chat_template_kwargs: { custom: 'keep' },
    })
    expect(applyReasoningEffort(payload, 'max', 'tinfoil')).toEqual({
      reasoning_effort: 'max',
      chat_template_kwargs: { custom: 'keep' },
    })
  })
})

it.each([
  ['openrouter', 'openrouter'],
  ['tinfoil', 'tinfoil'],
  ['openai', 'openai'],
  ['thunderbolt', 'openai'],
  ['custom-provider', 'openai'],
] as const)('uses %s provider effort encoding %s', (provider, format) => {
  expect(reasoningEffortFormat(provider)).toBe(format)
})
