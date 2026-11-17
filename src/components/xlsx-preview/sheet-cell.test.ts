/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { fitNumber } from './sheet-cell'

// Every character 8 pixels wide.
const measure = (text: string) => text.length * 8

describe('fitNumber', () => {
  it('keeps a number that fits its cell whole', () => {
    expect(fitNumber('1,500.50', 64, measure)).toBe('1,500.50')
  })

  it('fills a cell too narrow for its number with hashes, never part of the value', () => {
    expect(fitNumber('1,234,567.89', 59, measure)).toBe('#######')
  })

  it('shows one hash in a cell narrower than one', () => {
    expect(fitNumber('2026-09-01', 3, measure)).toBe('#')
  })
})
