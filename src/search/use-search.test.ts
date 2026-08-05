/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { toFtsMatchQuery } from './use-search'

describe('toFtsMatchQuery', () => {
  it('returns an empty string for an empty query', () => {
    expect(toFtsMatchQuery('')).toBe('')
  })

  it('returns an empty string for a whitespace-only query', () => {
    expect(toFtsMatchQuery('   \t \n ')).toBe('')
  })

  it('quotes and prefix-globs a single token', () => {
    expect(toFtsMatchQuery('hello')).toBe('"hello"*')
  })

  it('quotes and prefix-globs each token in a multi-token query', () => {
    expect(toFtsMatchQuery('hello wor')).toBe('"hello"* "wor"*')
  })

  it('collapses runs of mixed whitespace between tokens', () => {
    expect(toFtsMatchQuery('  hello \t\n  world  ')).toBe('"hello"* "world"*')
  })

  it('escapes embedded double quotes by doubling them', () => {
    expect(toFtsMatchQuery('foo"bar')).toBe('"foo""bar"*')
  })

  it('neutralizes a leading dash (would otherwise be a NOT operator)', () => {
    expect(toFtsMatchQuery('-foo')).toBe('"-foo"*')
  })

  it('neutralizes an embedded star (would otherwise be an unbalanced glob)', () => {
    expect(toFtsMatchQuery('foo*bar')).toBe('"foo*bar"*')
  })

  it('neutralizes a colon (would otherwise be a column filter)', () => {
    expect(toFtsMatchQuery('foo:bar')).toBe('"foo:bar"*')
  })

  it('handles a mix of special characters across tokens', () => {
    expect(toFtsMatchQuery('c++ "quoted" a:b')).toBe('"c++"* """quoted"""* "a:b"*')
  })
})
