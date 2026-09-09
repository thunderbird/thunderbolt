/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { getLanguageScenarios } from './language-scenarios'
import { categoryGateThresholds } from './stats'

const localId = (id: string) => id.split('/').at(-1) ?? ''

describe('language scenarios', () => {
  test('declares the reply-language assertion on every scenario', () => {
    const scenarios = getLanguageScenarios(['opus'])

    expect(scenarios.length).toBeGreaterThan(0)
    expect(scenarios.every(({ criteria }) => criteria.expectReplyLanguage !== undefined)).toBe(true)
    expect(scenarios.every(({ criteria }) => criteria.mustProduceOutput)).toBe(true)
    expect(scenarios.every(({ category }) => category === 'language')).toBe(true)
  })

  test('uses unique human-readable ids and review dates, like the necessity suite', () => {
    const scenarios = getLanguageScenarios(['opus'])
    const localIds = scenarios.map(({ id }) => localId(id))

    expect(new Set(localIds).size).toBe(localIds.length)
    expect(localIds.every((id) => /^[a-z]+(?:-[a-z]+)*-\d{2}$/.test(id))).toBe(true)
    expect(scenarios.every(({ reviewBy }) => /^\d{4}-\d{2}-\d{2}$/.test(reviewBy ?? ''))).toBe(true)
  })

  test('expects the thread language rather than the app language where a message establishes one', () => {
    const byId = new Map(getLanguageScenarios(['opus'], undefined, 'ja').map((s) => [localId(s.id), s]))

    // A Portuguese thread stays Portuguese even when the app is set to Japanese —
    // this is what makes the suite meaningful under any EVAL_LANGUAGE.
    expect(byId.get('language-establish-01')?.criteria.expectReplyLanguage).toBe('pt-BR')
    expect(byId.get('language-sticky-paste-01')?.criteria.expectReplyLanguage).toBe('pt-BR')
    expect(byId.get('language-sticky-search-01')?.criteria.expectReplyLanguage).toBe('pt-BR')
    expect(byId.get('language-explicit-switch-01')?.criteria.expectReplyLanguage).toBe('en')
    expect(byId.get('language-negative-control-01')?.criteria.expectReplyLanguage).toBe('en')
  })

  test('expects the run app language only where the turn establishes none', () => {
    const fallbackIds = ['language-fallback-code-01', 'language-fallback-terse-01']

    for (const locale of ['en', 'ja', 'pt-BR'] as const) {
      const byId = new Map(getLanguageScenarios(['opus'], undefined, locale).map((s) => [localId(s.id), s]))
      for (const id of fallbackIds) {
        expect(byId.get(id)?.criteria.expectReplyLanguage).toBe(locale)
      }
    }
  })

  test('requires a real web call only for the search-stickiness scenario', () => {
    const scenarios = getLanguageScenarios(['opus'])
    const withMinToolCalls = scenarios.filter(({ criteria }) => criteria.minToolCalls !== undefined)

    expect(withMinToolCalls.map(({ id }) => localId(id))).toEqual(['language-sticky-search-01'])
    expect(withMinToolCalls[0].criteria.minToolCalls).toBe(1)
    // Chat's `auto` budget is two calls; a scenario that spends it produces no prose to judge.
    expect(withMinToolCalls[0].criteria.maxToolCalls).toBe(2)
  })

  test('carries a stickiness scenario that pastes foreign-language content mid-thread', () => {
    const sticky = getLanguageScenarios(['opus']).find(({ id }) => localId(id) === 'language-sticky-paste-01')

    expect(sticky?.followUps).toHaveLength(1)
    expect(sticky?.followUps?.[0]).toContain('Traceback (most recent call last)')
  })

  test('includes a negative control so the directive cannot pass by always switching', () => {
    const controls = getLanguageScenarios(['opus']).filter(({ isNegativeControl }) => isNegativeControl)

    expect(controls).toHaveLength(1)
    expect(controls[0].criteria.expectReplyLanguage).toBe('en')
  })

  test('runs in chat mode across the model matrix and gates as tightly as never_search', () => {
    const scenarios = getLanguageScenarios()

    expect(scenarios.every(({ modeName }) => modeName === 'chat')).toBe(true)
    expect(new Set(scenarios.map(({ modelName }) => modelName)).size).toBeGreaterThan(1)
    expect(categoryGateThresholds.language).toBe(categoryGateThresholds.never_search)
  })

  test('honors the model and engine filters', () => {
    expect(getLanguageScenarios(['opus']).every(({ modelName }) => modelName === 'opus')).toBe(true)
    expect(getLanguageScenarios(undefined, ['legacy']).every(({ engineName }) => engineName === 'legacy')).toBe(true)
    expect(getLanguageScenarios(['no-such-model'])).toHaveLength(0)
  })
})
