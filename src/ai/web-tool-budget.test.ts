/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  budgetExhaustedResult,
  createWebToolBudget,
  normalizeWebToolKey,
  resolveWebToolIntent,
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
