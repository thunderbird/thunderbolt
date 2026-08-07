/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Reasoning-depth derivation. This is the one translation from per-provider
 * `providerOptions` dialects into the single level enum both the in-browser
 * harness and the runner accept, so the same thread reasons identically wherever
 * its turn executes.
 */

import type { ModelProfile } from '@/types'
import { describe, expect, it } from 'bun:test'
import { deriveThinkingLevel, hasExplicitReasoning, readProfileThinkingLevel } from './thinking-level'

const profile = (providerOptions: Record<string, unknown> | null): ModelProfile => ({ providerOptions }) as ModelProfile

describe('readProfileThinkingLevel', () => {
  it('reads no reasoning config as absent', () => {
    expect(readProfileThinkingLevel(null)).toBeNull()
    expect(readProfileThinkingLevel({})).toBeNull()
  })

  it('accepts an OpenAI-style effort in either casing', () => {
    expect(readProfileThinkingLevel({ reasoningEffort: 'high' })).toBe('high')
    expect(readProfileThinkingLevel({ reasoning_effort: 'low' })).toBe('low')
  })

  it('accepts a nested reasoning effort', () => {
    expect(readProfileThinkingLevel({ reasoning: { effort: 'xhigh' } })).toBe('xhigh')
  })

  it('maps the explicit off signals to off', () => {
    expect(readProfileThinkingLevel({ reasoningEffort: 'none' })).toBe('off')
    expect(readProfileThinkingLevel({ reasoningEffort: 'off' })).toBe('off')
    expect(readProfileThinkingLevel({ thinking: { type: 'disabled' } })).toBe('off')
  })

  it('rejects an effort string that is not a level', () => {
    expect(readProfileThinkingLevel({ reasoningEffort: 'ludicrous' })).toBeNull()
  })

  it('buckets an Anthropic-style thinking budget', () => {
    expect(readProfileThinkingLevel({ thinking: { budgetTokens: 0 } })).toBe('off')
    expect(readProfileThinkingLevel({ thinking: { budgetTokens: 512 } })).toBe('minimal')
    expect(readProfileThinkingLevel({ thinking: { budgetTokens: 4096 } })).toBe('low')
    expect(readProfileThinkingLevel({ thinking: { budgetTokens: 12288 } })).toBe('medium')
    expect(readProfileThinkingLevel({ thinking: { budgetTokens: 32000 } })).toBe('high')
  })

  it('prefers an explicit effort over a thinking budget', () => {
    expect(readProfileThinkingLevel({ reasoningEffort: 'minimal', thinking: { budgetTokens: 32000 } })).toBe('minimal')
  })
})

describe('deriveThinkingLevel', () => {
  it('falls back to medium for a model that configures nothing', () => {
    expect(deriveThinkingLevel(null)).toBe('medium')
    expect(deriveThinkingLevel(profile({}))).toBe('medium')
  })

  it('honors an explicit off rather than falling back', () => {
    expect(deriveThinkingLevel(profile({ reasoningEffort: 'off' }))).toBe('off')
  })

  it('returns the configured level', () => {
    expect(deriveThinkingLevel(profile({ reasoningEffort: 'high' }))).toBe('high')
  })
})

describe('hasExplicitReasoning', () => {
  it('is false without config, so an unconfigured model stays non-reasoning', () => {
    expect(hasExplicitReasoning(null)).toBe(false)
    expect(hasExplicitReasoning(profile({}))).toBe(false)
  })

  it('is false for an explicit off', () => {
    expect(hasExplicitReasoning(profile({ thinking: { type: 'disabled' } }))).toBe(false)
  })

  it('is true for any configured non-off level', () => {
    expect(hasExplicitReasoning(profile({ reasoningEffort: 'minimal' }))).toBe(true)
  })
})
