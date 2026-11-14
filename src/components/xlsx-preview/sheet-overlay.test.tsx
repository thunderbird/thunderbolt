/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Overlay } from '@/office/xlsx-preview-reader'
import { render } from '@testing-library/react'
import { describe, expect, it, spyOn } from 'bun:test'
import { SheetOverlays } from './sheet-overlay'

describe('SheetOverlays', () => {
  it('does not draw its charts again when the grid around it renders with the same overlays', () => {
    const overlays: Overlay[] = [
      {
        type: 'chart',
        kind: 'line',
        stacking: 'none',
        title: 'Spend',
        categories: ['Q1', 'Q2'],
        series: [{ name: 'Rent', values: [1, 2] }],
        x: 0,
        y: 0,
        width: 300,
        height: 200,
      },
    ]
    // The layer maps its overlays each time it renders.
    const draws = spyOn(overlays, 'map')
    const grid = (activeCell: number) => (
      <div data-active={activeCell}>
        <SheetOverlays overlays={overlays} />
      </div>
    )
    const { rerender } = render(grid(0))
    draws.mockClear()

    rerender(grid(1))

    expect(draws).not.toHaveBeenCalled()
  })
})
