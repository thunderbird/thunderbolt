/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { caseName, sweepCases, uncoveredPairs } from './sweep'

describe('sweepCases', () => {
  test('covers every pair of values of any two dimensions', () => expect(uncoveredPairs(sweepCases)).toEqual([]))

  test('stays far below the full product', () => expect(sweepCases.length).toBe(24))

  test('names each case once', () => expect(new Set(sweepCases.map(caseName)).size).toBe(sweepCases.length))
})

describe('uncoveredPairs', () => {
  test('names the pairs a set misses', () => {
    const missing = uncoveredPairs(sweepCases.filter((c) => !(c.locale === 'ja' && c.text === 'large')))
    expect(missing).toContain('locale=ja+text=large')
  })
})
