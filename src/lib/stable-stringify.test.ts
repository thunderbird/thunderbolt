/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { stableStringify, toolCallKey } from './stable-stringify'

describe('stableStringify', () => {
  test('is invariant to object key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
  })

  test('sorts nested object keys', () => {
    expect(stableStringify({ outer: { a: 1, b: 2 } })).toBe(stableStringify({ outer: { b: 2, a: 1 } }))
  })

  test('preserves array order (order is meaningful)', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })

  test('handles primitives and null', () => {
    expect(stableStringify('x')).toBe('"x"')
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify(42)).toBe('42')
  })
})

describe('toolCallKey', () => {
  test('combines tool name with stable-stringified input', () => {
    expect(toolCallKey('search', { q: 'x' })).toBe('search:{"q":"x"}')
  })

  test('is invariant to input key order', () => {
    expect(toolCallKey('search', { a: 1, b: 2 })).toBe(toolCallKey('search', { b: 2, a: 1 }))
  })

  test('the same input on different tools yields different keys', () => {
    expect(toolCallKey('search', { q: 'x' })).not.toBe(toolCallKey('fetch_content', { q: 'x' }))
  })
})
