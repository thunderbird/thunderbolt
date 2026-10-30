/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { nextPinnedOrder } from './use-skills'

describe('nextPinnedOrder', () => {
  it('starts at zero with no pins', () => {
    expect(nextPinnedOrder([])).toBe(0)
  })

  it('lands after the last pin when positions have a gap', () => {
    expect(nextPinnedOrder([{ pinnedOrder: 0 }, { pinnedOrder: 2 }])).toBe(3)
  })
})
