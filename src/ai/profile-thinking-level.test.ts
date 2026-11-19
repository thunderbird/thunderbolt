/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { reasoningEfforts } from '@shared/reasoning-effort'
import { resolveProfileReasoningEffort, readProfileThinkingLevel } from './profile-thinking-level'

describe('readProfileThinkingLevel', () => {
  it.each(['high', 'max'] as const)('preserves adaptive Anthropic profile effort %s', (effort) => {
    expect(readProfileThinkingLevel({ thinking: { type: 'adaptive' }, effort })).toBe(effort)
  })

  it('keeps disabled Anthropic thinking off despite a stored effort', () => {
    expect(readProfileThinkingLevel({ thinking: { type: 'disabled' }, effort: 'max' })).toBe('off')
  })

  it('prefers native effort fields and ignores malformed adaptive effort', () => {
    expect(readProfileThinkingLevel({ reasoningEffort: 'low', effort: 'max' })).toBe('low')
    expect(readProfileThinkingLevel({ reasoning: { effort: 'high' }, effort: 'max' })).toBe('high')
    expect(readProfileThinkingLevel({ effort: 'unsupported', thinking: { budgetTokens: 4096 } })).toBe('low')
  })

  it('ignores a non-object JSON value from the synced profile column', () => {
    expect(readProfileThinkingLevel(['high'] as never)).toBeNull()
  })

  it('keeps valid reasoning fields when a sibling field is malformed', () => {
    expect(
      readProfileThinkingLevel({
        reasoningEffort: null as never,
        reasoning_effort: 'high',
      }),
    ).toBe('high')
  })
})

it.each([
  [{ reasoningEffort: 'none' }, 'none'],
  [{ reasoningEffort: 'off' }, 'none'],
  [{ reasoning_effort: 'max' }, 'max'],
  [{ reasoning: { effort: 'low' } }, 'low'],
  [{ reasoning: { enabled: false } }, 'none'],
  [{ reasoning: { enabled: true } }, 'medium'],
  [{ reasoning: { enabled: true, max_tokens: 16384 } }, 'high'],
  [{ reasoning: { enabled: false, max_tokens: 16384 } }, 'none'],
  [{ reasoning: { effort: 'low', enabled: false } }, 'low'],
  [{ reasoning: { max_tokens: 1024 } }, 'minimal'],
  [{ reasoning: { max_tokens: 16384 } }, 'high'],
  [{ reasoning: { max_tokens: 'invalid', enabled: true } }, 'medium'],
  [{ reasoning: { enabled: 'invalid' } }, undefined],
  [{ reasoning: { exclude: true } }, undefined],
  [{ thinking: { type: 'disabled' }, effort: 'max' }, 'none'],
  [{ thinking: { budgetTokens: -1 } }, 'none'],
  [{ thinking: { budgetTokens: 0 } }, 'none'],
  [{ thinking: { budgetTokens: 1 } }, 'minimal'],
  [{ thinking: { budgetTokens: 1024 } }, 'minimal'],
  [{ thinking: { budgetTokens: 1025 } }, 'low'],
  [{ thinking: { budgetTokens: 4096 } }, 'low'],
  [{ thinking: { budgetTokens: 4097 } }, 'medium'],
  [{ thinking: { budgetTokens: 12288 } }, 'medium'],
  [{ thinking: { budgetTokens: 12289 } }, 'high'],
  [{ thinking: { budgetTokens: Infinity } }, undefined],
  [{ thinking: { budgetTokens: NaN } }, undefined],
  [{ reasoningEffort: 'unsupported', effort: 'high' }, 'high'],
  [{ reasoningEffort: 'unsupported' }, undefined],
  [null, undefined],
  [undefined, undefined],
] as const)('normalizes the configured profile effort %j to %s', (options, expected) => {
  expect(resolveProfileReasoningEffort(options, { efforts: reasoningEfforts })).toBe(expected)
})

it('shows configured budgets as On for toggles and rejects unsupported profile effort levels', () => {
  const toggle = { kind: 'toggle', efforts: ['none', 'high'] } as const
  expect(resolveProfileReasoningEffort({ thinking: { budgetTokens: 16384 } }, toggle)).toBe('high')
  expect(resolveProfileReasoningEffort({ thinking: { budgetTokens: 4096 } }, toggle)).toBe('high')
  expect(resolveProfileReasoningEffort({ thinking: { type: 'disabled' } }, toggle)).toBe('none')
  expect(resolveProfileReasoningEffort(null, toggle)).toBeUndefined()
  expect(resolveProfileReasoningEffort({ reasoningEffort: 'max' }, { efforts: ['low', 'high'] })).toBeNull()
  expect(resolveProfileReasoningEffort({ reasoningEffort: 'high' }, { efforts: [] })).toBeNull()
})

it('does not invent a selection when native profile reasoning is outside the advertised effort scale', () => {
  const capabilities = { efforts: ['low', 'high'] } as const
  expect(resolveProfileReasoningEffort({ reasoning: { max_tokens: 1024 } }, capabilities)).toBeNull()
  expect(resolveProfileReasoningEffort({ reasoning: { enabled: false } }, capabilities)).toBeNull()
  expect(resolveProfileReasoningEffort({ reasoning: { enabled: true } }, capabilities)).toBeNull()
})
