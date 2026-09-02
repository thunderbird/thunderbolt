/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isMeaningfulDrag, rectFromDrag } from './marquee-overlay'

describe('rectFromDrag', () => {
  it('builds a rect when dragged down-right', () => {
    expect(rectFromDrag({ x: 10, y: 20 }, { x: 60, y: 90 })).toEqual({ x: 10, y: 20, width: 50, height: 70 })
  })

  // Users drag in every direction; a raw end-minus-start would give negative
  // width and the box would render inside-out (or not at all).
  it('normalizes a drag made up-left to the same rect', () => {
    expect(rectFromDrag({ x: 60, y: 90 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 50, height: 70 })
  })

  it('normalizes a mixed-direction drag', () => {
    expect(rectFromDrag({ x: 60, y: 20 }, { x: 10, y: 90 })).toEqual({ x: 10, y: 20, width: 50, height: 70 })
  })

  it('produces a zero-area rect when start and end coincide', () => {
    expect(rectFromDrag({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, width: 0, height: 0 })
  })
})

describe('isMeaningfulDrag', () => {
  // A plain click inside select mode should exit, not query the guest with a
  // 1px box and report "nothing selectable".
  it('rejects a click', () => {
    expect(isMeaningfulDrag(rectFromDrag({ x: 5, y: 5 }, { x: 5, y: 5 }))).toBe(false)
  })

  it('rejects a tiny jitter drag', () => {
    expect(isMeaningfulDrag(rectFromDrag({ x: 5, y: 5 }, { x: 9, y: 9 }))).toBe(false)
  })

  // A thin box is a legitimate way to grab one row, and the both-axes rule used
  // to discard it — the user swiped across a row and select mode just exited.
  it('accepts a drag that is wide but not tall', () => {
    expect(isMeaningfulDrag({ x: 0, y: 0, width: 400, height: 2 })).toBe(true)
  })

  // The same gesture turned ninety degrees: one column of a table.
  it('accepts a drag that is tall but not wide', () => {
    expect(isMeaningfulDrag({ x: 0, y: 0, width: 2, height: 400 })).toBe(true)
  })

  it('accepts a deliberate drag', () => {
    expect(isMeaningfulDrag(rectFromDrag({ x: 0, y: 0 }, { x: 200, y: 60 }))).toBe(true)
  })
})
