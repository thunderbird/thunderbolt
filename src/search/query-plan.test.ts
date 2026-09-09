/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { planSearchQuery, toLikePattern } from './query-plan'

describe('planSearchQuery', () => {
  describe('space-delimited scripts go to MATCH', () => {
    it('plans nothing for an empty or whitespace-only query', () => {
      expect(planSearchQuery('')).toEqual({ match: null, substrings: [] })
      expect(planSearchQuery('   \t \n ')).toEqual({ match: null, substrings: [] })
    })

    it('quotes each token and appends the prefix operator', () => {
      expect(planSearchQuery('hello')).toEqual({ match: '"hello"*', substrings: [] })
      expect(planSearchQuery('hello wor')).toEqual({ match: '"hello"* "wor"*', substrings: [] })
    })

    it('collapses mixed whitespace between tokens', () => {
      expect(planSearchQuery('  hello \t\n  world  ').match).toBe('"hello"* "world"*')
    })

    it('doubles embedded quotes per FTS5 escaping', () => {
      expect(planSearchQuery('foo"bar').match).toBe('"foo""bar"*')
    })

    it('neutralizes FTS5 operators inside a token', () => {
      expect(planSearchQuery('-foo').match).toBe('"-foo"*')
      expect(planSearchQuery('foo*bar').match).toBe('"foo*bar"*')
      expect(planSearchQuery('a:b').match).toBe('"a:b"*')
    })

    it('treats Korean as tokenizable — it spaces its phrases', () => {
      expect(planSearchQuery('서울')).toEqual({ match: '"서울"*', substrings: [] })
    })
  })

  describe('unsegmented scripts go to substring matching', () => {
    it('routes a Japanese term away from MATCH entirely', () => {
      expect(planSearchQuery('天気')).toEqual({ match: null, substrings: ['天気'] })
    })

    it('segments a run into words so a particle-free query still matches', () => {
      // The whole point of segmenting: `東京天気` has to find `東京の天気`.
      expect(planSearchQuery('東京天気').substrings).toEqual(['東京', '天気'])
    })

    it('drops single-character particles', () => {
      expect(planSearchQuery('東京の天気').substrings).toEqual(['東京', '天気'])
    })

    it('keeps a single character when that is the whole query', () => {
      expect(planSearchQuery('犬').substrings).toEqual(['犬'])
    })

    it('strips punctuation rather than matching on it', () => {
      expect(planSearchQuery('天気。').substrings).toEqual(['天気'])
      expect(planSearchQuery('「会議」').substrings).toEqual(['会議'])
    })

    it('leaves CJK punctuation alone in MATCH, where unicode61 discards it', () => {
      // `。` is script Common, not Han, so it never reaches the segmenter. It
      // lands in MATCH and tokenizes to nothing — the same dead end as a query
      // of just `%`, and equally harmless.
      expect(planSearchQuery('。')).toEqual({ match: '"。"*', substrings: [] })
    })

    it('segments Thai, which also does not space its words', () => {
      const plan = planSearchQuery('สวัสดีครับ')
      expect(plan.match).toBeNull()
      expect(plan.substrings).toEqual(['สวัสดี', 'ครับ'])
    })

    it('segments Chinese with the Han dictionary', () => {
      expect(planSearchQuery('北京的天气').substrings).toEqual(['北京', '天气'])
    })
  })

  describe('mixed queries use both strategies', () => {
    it('splits across whitespace-separated tokens', () => {
      expect(planSearchQuery('sao 天気')).toEqual({ match: '"sao"*', substrings: ['天気'] })
    })

    it('splits inside a single token at the script boundary', () => {
      expect(planSearchQuery('Claude設定')).toEqual({ match: '"Claude"*', substrings: ['設定'] })
    })

    it('keeps digits on the MATCH side', () => {
      expect(planSearchQuery('100%の確率')).toEqual({ match: '"100"*', substrings: ['確率'] })
    })
  })
})

describe('toLikePattern', () => {
  it('wraps the term for a contains match', () => {
    expect(toLikePattern('天気')).toBe('%天気%')
  })

  it('escapes the wildcards, so a bare wildcard cannot match every row', () => {
    expect(toLikePattern('%')).toBe('%\\%%')
    expect(toLikePattern('_')).toBe('%\\_%')
    expect(toLikePattern('50%')).toBe('%50\\%%')
  })

  it('escapes the escape character itself', () => {
    expect(toLikePattern('a\\b')).toBe('%a\\\\b%')
  })
})
