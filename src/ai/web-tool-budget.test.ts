/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  budgetExhaustedResult,
  createWebToolBudget,
  normalizeWebToolKey,
  resolveWebToolIntent,
  resolveWebBudgetPromotion,
  webToolCaps,
  type WebToolIntent,
} from './web-tool-budget'

describe('resolveWebToolIntent', () => {
  it('resolves explicit search and research slugs without sniffing prose', () => {
    expect(resolveWebToolIntent('/search latest releases')).toBe('search')
    expect(resolveWebToolIntent('compare these /research sources')).toBe('research')
    expect(resolveWebToolIntent('please search for this')).toBe('auto')
  })

  it('gives research precedence when both slugs appear', () => {
    expect(resolveWebToolIntent('/search then /research')).toBe('research')
  })
})

describe('createWebToolBudget', () => {
  for (const intent of Object.keys(webToolCaps) as WebToolIntent[]) {
    it(`enforces the ${intent} cap`, async () => {
      const budget = createWebToolBudget(intent)
      for (let call = 0; call < webToolCaps[intent]; call++) {
        await expect(budget.execute('search', { query: `query ${call}` }, async () => ({ call }))).resolves.toEqual({
          call,
        })
      }
      expect(budget.probe.isExhausted).toBe(true)
      await expect(
        budget.execute('search', { query: 'over budget' }, async () => ({ call: 'over budget' })),
      ).resolves.toMatchObject({ status: 'budget_exhausted' })
      expect(budget.probe.exhaustedAttempts).toBe(1)
    })
  }

  it('allows /search to fetch each homepage needed for ten target previews', () => {
    expect(webToolCaps.search).toBeGreaterThanOrEqual(11)
  })
})

describe('normalizeWebToolKey', () => {
  it('normalizes search query casing and whitespace while retaining other params', () => {
    expect(normalizeWebToolKey('search', { query: ' Foo  Bar ', limit: 3 })).toBe(
      normalizeWebToolKey('search', { limit: 3, query: 'foo bar' }),
    )
    expect(normalizeWebToolKey('search', { query: 'foo bar', limit: 3 })).not.toBe(
      normalizeWebToolKey('search', { query: 'foo bar', limit: 5 }),
    )
  })

  it('normalizes fetch URL host casing without conflating path trailing slashes', () => {
    expect(normalizeWebToolKey('fetch_content', { url: ' HTTPS://EXAMPLE.COM/path/ ' })).toBe(
      normalizeWebToolKey('fetch_content', { url: 'https://example.com/path/' }),
    )
    expect(normalizeWebToolKey('fetch_content', { url: 'https://example.com/path/' })).not.toBe(
      normalizeWebToolKey('fetch_content', { url: 'https://example.com/path' }),
    )
  })

  it('uses the raw trimmed value for unparseable URLs', () => {
    expect(normalizeWebToolKey('fetch_content', { url: ' not a url ' })).toBe(
      normalizeWebToolKey('fetch_content', { url: 'not a url' }),
    )
  })
})

it('returns a non-empty structured exhaustion result', () => {
  const result = budgetExhaustedResult()
  expect(result.status).toBe('budget_exhausted')
  expect(result.message.length).toBeGreaterThan(0)
})

describe('research promotion state table', () => {
  it('promotes auto to an absolute cap of 30 without resetting consumption, cache or sources', async () => {
    const budget = createWebToolBudget('auto', true)
    const pending = Promise.withResolvers<unknown>()
    const first = budget.execute('search', { query: 'first' }, () => pending.promise)
    const sources = budget.sourceCollector
    sources.push({ index: 1, url: 'https://source.test', title: 'Source', toolName: 'search' })
    budget.promoteToResearch()
    budget.promoteToResearch()
    expect(budget.cap).toBe(30)
    expect(budget.initialCap).toBe(2)
    expect(budget.promoted).toBe(true)
    expect(budget.consumed).toBe(1)
    expect(budget.execute('search', { query: 'first' }, async () => 'must stay cached')).toBe(first)
    expect(budget.sourceCollector).toBe(sources)
    pending.resolve('source')
    await first
    for (let index = 1; index < 30; index++) {
      await budget.execute('search', { query: String(index) }, async () => 'source')
    }
    expect(budget.probe.isExhausted).toBe(true)
    expect(await budget.execute('search', { query: 'denied' }, async () => 'bad')).toEqual(budgetExhaustedResult())
    expect(budget.consumed).toBe(30)
  })

  it.each(['search', 'research'] as const)('keeps explicit %s caps after repeated research loads', (intent) => {
    const budget = createWebToolBudget(intent, true)
    budget.promoteToResearch()
    budget.promoteToResearch()
    expect(budget.cap).toBe(webToolCaps[intent])
    expect(budget.promoted).toBe(false)
  })

  it('never promotes from exhaustion alone; a later permitted load reopens live capacity', async () => {
    const budget = createWebToolBudget('auto', true)
    for (const query of ['one', 'two', 'denied']) {
      await budget.execute('search', { query }, async () => query)
    }
    expect(budget.cap).toBe(2)
    expect(budget.probe.isExhausted).toBe(true)
    budget.promoteToResearch()
    expect(budget.cap).toBe(30)
    expect(budget.consumed).toBe(2)
    expect(budget.probe.exhaustedAttempts).toBe(1)
    expect(budget.probe.isExhausted).toBe(false)
  })

  it('keeps the original cap when promotion is off and starts fresh on a new budget', () => {
    const disabled = createWebToolBudget('auto', false)
    disabled.promoteToResearch()
    expect(disabled.cap).toBe(2)
    const promoted = createWebToolBudget('auto', true)
    promoted.promoteToResearch()
    const fresh = createWebToolBudget('auto', true)
    expect(fresh.cap).toBe(2)
    expect(fresh.promoted).toBe(false)
  })

  it('accepts only on/off, with unset defaulting on', () => {
    expect(resolveWebBudgetPromotion(undefined)).toBe(true)
    expect(resolveWebBudgetPromotion('on')).toBe(true)
    expect(resolveWebBudgetPromotion('off')).toBe(false)
    for (const value of ['', '0', '1', 'true', 'ON', 'offf']) {
      expect(() => resolveWebBudgetPromotion(value)).toThrow('WEB_BUDGET_PROMOTION')
    }
  })
})

it('reads the run option at construction and rejects invalid values before execution', () => {
  const prior = process.env.WEB_BUDGET_PROMOTION
  try {
    process.env.WEB_BUDGET_PROMOTION = 'on'
    const enabled = createWebToolBudget('auto')
    process.env.WEB_BUDGET_PROMOTION = 'off'
    enabled.promoteToResearch()
    expect(enabled.cap).toBe(30)
    const disabled = createWebToolBudget('auto')
    disabled.promoteToResearch()
    expect(disabled.cap).toBe(2)
    process.env.WEB_BUDGET_PROMOTION = 'invalid'
    expect(() => createWebToolBudget('auto')).toThrow('WEB_BUDGET_PROMOTION')
  } finally {
    if (prior === undefined) {
      delete process.env.WEB_BUDGET_PROMOTION
    } else {
      process.env.WEB_BUDGET_PROMOTION = prior
    }
  }
})
