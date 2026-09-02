/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { hasExactKeys, isNonblankString } from './json.ts'

describe('JSON validators', () => {
  test('accepts only objects with the requested own enumerable keys', () => {
    expect(hasExactKeys({ id: 'one', label: 'One' }, ['id', 'label'])).toBe(true)
    expect(hasExactKeys({ id: 'one' }, ['id', 'label'])).toBe(false)
    expect(hasExactKeys({ id: 'one', label: 'One', extra: true }, ['id', 'label'])).toBe(false)
  })

  test('accepts strings containing non-whitespace content', () => {
    expect(isNonblankString(' value ')).toBe(true)
    expect(isNonblankString(' \n\t')).toBe(false)
    expect(isNonblankString(null)).toBe(false)
  })
})
