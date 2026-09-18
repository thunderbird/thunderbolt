/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { advanceTextReveal, initialTextReveal } from './text-reveal'

describe('advanceTextReveal', () => {
  it('carries fractional progress and clamps completion, shrink and negative time', () => {
    const first = advanceTextReveal(initialTextReveal, 10, 3)
    expect(first).toEqual({ revealed: 0, carryMs: 3 })
    expect(advanceTextReveal(first, 10, 3)).toEqual({ revealed: 1, carryMs: 1 })
    expect(advanceTextReveal(first, 10, -5)).toEqual(first)
    expect(advanceTextReveal(first, 10, 1000)).toEqual({ revealed: 10, carryMs: 0 })
    expect(advanceTextReveal({ revealed: 40, carryMs: 2 }, 30, 16)).toEqual({ revealed: 30, carryMs: 0 })
  })

  it('drains a large burst gradually, with a response constant rather than a 250ms deadline', () => {
    const progress = { state: initialTextReveal, elapsed: 0 }
    while (progress.state.revealed < 1000 && progress.elapsed < 2000) {
      progress.state = advanceTextReveal(progress.state, 1000, 16)
      progress.elapsed += 16
      if (progress.elapsed === 256) {
        expect(progress.state.revealed).toBeGreaterThan(600)
        expect(progress.state.revealed).toBeLessThan(700)
      }
    }
    expect(progress.state.revealed).toBe(1000)
    expect(progress.elapsed).toBe(976)
  })
})
