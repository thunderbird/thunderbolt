/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { barSpans } from './chart-geometry'

const spans = (stacking: 'none' | 'stacked' | 'percent', ...rows: number[][]) =>
  barSpans({ stacking, series: rows.map((values, i) => ({ name: `s${i}`, values })) }, rows[0].length)

describe('barSpans', () => {
  it('runs each side-by-side bar from zero', () => {
    expect(spans('none', [3, -2], [5, 1])).toEqual([
      [
        { from: 0, to: 3 },
        { from: 0, to: -2 },
      ],
      [
        { from: 0, to: 5 },
        { from: 0, to: 1 },
      ],
    ])
  })

  it('stacks positive and negative values on their own sides', () => {
    expect(spans('stacked', [3, -2], [5, -1], [-4, 6])).toEqual([
      [
        { from: 0, to: 3 },
        { from: 0, to: -2 },
      ],
      [
        { from: 3, to: 8 },
        { from: -2, to: -3 },
      ],
      [
        { from: 0, to: -4 },
        { from: 0, to: 6 },
      ],
    ])
  })

  it('makes each percent-stacked category a share of its magnitudes', () => {
    expect(spans('percent', [1, 3], [3, -1])).toEqual([
      [
        { from: 0, to: 25 },
        { from: 0, to: 75 },
      ],
      [
        { from: 25, to: 100 },
        { from: 0, to: -25 },
      ],
    ])
  })

  it('keeps a percent-stacked category of huge values within 100%', () => {
    expect(spans('percent', [1e308], [1e308])).toEqual([[{ from: 0, to: 50 }], [{ from: 50, to: 100 }]])
  })

  it('leaves an empty percent-stacked category at zero', () => {
    expect(spans('percent', [0], [0])).toEqual([[{ from: 0, to: 0 }], [{ from: 0, to: 0 }]])
  })
})
