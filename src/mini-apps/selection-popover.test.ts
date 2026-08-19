/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { placeSelectionPopover } from './selection-popover'

describe('placeSelectionPopover', () => {
  it('centres the control horizontally on the selection', () => {
    const { left } = placeSelectionPopover({ x: 100, y: 300, width: 80, height: 20 })
    expect(left).toBe(140)
  })

  it('sits above the selection when there is room', () => {
    const { top, flipped } = placeSelectionPopover({ x: 0, y: 300, width: 10, height: 20 })
    expect(flipped).toBe(false)
    expect(top).toBeLessThan(300)
  })

  // A selection near the top of the frame would otherwise put the control
  // off-screen, where it can't be clicked.
  it('flips below the selection when the selection is near the top', () => {
    const { top, flipped } = placeSelectionPopover({ x: 0, y: 4, width: 10, height: 20 })
    expect(flipped).toBe(true)
    expect(top).toBeGreaterThan(4 + 20)
  })

  it('handles a zero-width selection without producing NaN', () => {
    const { left, top } = placeSelectionPopover({ x: 50, y: 200, width: 0, height: 0 })
    expect(Number.isFinite(left)).toBe(true)
    expect(Number.isFinite(top)).toBe(true)
    expect(left).toBe(50)
  })

  // Selections in a scrolled frame can report negative coordinates; the control
  // should still be placed deterministically rather than clamped somewhere odd.
  it('accepts negative coordinates from a scrolled frame', () => {
    const { left, flipped } = placeSelectionPopover({ x: -20, y: -5, width: 40, height: 16 })
    expect(left).toBe(0)
    expect(flipped).toBe(true)
  })
})
