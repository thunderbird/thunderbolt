/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { findMovedItem } from './find-moved-item'

describe('findMovedItem', () => {
  it('returns null when orderings are identical', () => {
    expect(findMovedItem(['a', 'b', 'c'], ['a', 'b', 'c'])).toBeNull()
  })

  it('returns null when lengths differ', () => {
    expect(findMovedItem(['a', 'b'], ['a', 'b', 'c'])).toBeNull()
    expect(findMovedItem(['a', 'b', 'c'], ['a', 'b'])).toBeNull()
  })

  it('detects a forward move (drag down)', () => {
    expect(findMovedItem(['a', 'b', 'c', 'd'], ['b', 'c', 'a', 'd'])).toEqual({ id: 'a', from: 0, to: 2 })
  })

  it('detects a backward move (drag up)', () => {
    expect(findMovedItem(['a', 'b', 'c', 'd'], ['a', 'd', 'b', 'c'])).toEqual({ id: 'd', from: 3, to: 1 })
  })

  it('detects a swap of adjacent items (treated as a single move)', () => {
    expect(findMovedItem(['a', 'b'], ['b', 'a'])).toEqual({ id: 'a', from: 0, to: 1 })
  })

  it('returns null for a true multi-move (two ids moved out of clean-shift range)', () => {
    // Swap of two non-adjacent items: 'a' and 'd' both moved, not a single
    // arrayMove drag — `from`/`to` would be ambiguous, so we skip telemetry.
    expect(findMovedItem(['a', 'b', 'c', 'd'], ['d', 'b', 'c', 'a'])).toBeNull()
  })

  it('returns null when an id from the old array is missing in the new (defensive)', () => {
    expect(findMovedItem(['a', 'b', 'c'], ['a', 'b', 'x'])).toBeNull()
  })
})
