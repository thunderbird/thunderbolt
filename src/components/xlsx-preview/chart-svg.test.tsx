/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Stacking } from '@/office/xlsx-drawings'
import type { Overlay } from '@/office/xlsx-preview-reader'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { ChartSvg } from './chart-svg'

const columns = (stacking: Stacking, values = [10, 30]): Extract<Overlay, { type: 'chart' }> => ({
  type: 'chart',
  kind: 'column',
  stacking,
  title: '',
  categories: ['Q1'],
  series: [
    { name: 'Rent', values: [values[0]] },
    { name: 'Food', values: [values[1]] },
  ],
  x: 0,
  y: 0,
  width: 300,
  height: 200,
})

/** The chart's bars, without the legend's swatches, as numbers. */
const barsOf = (stacking: Stacking, values?: number[]) => {
  const { container } = render(<ChartSvg chart={columns(stacking, values)} style={{}} />)
  return [...container.querySelectorAll('rect')]
    .filter((rect) => rect.getAttribute('width') !== '8')
    .map((rect) => ({
      x: Number(rect.getAttribute('x')),
      y: Number(rect.getAttribute('y')),
      height: Number(rect.getAttribute('height')),
    }))
}

describe('ChartSvg', () => {
  it('draws side-by-side columns from zero', () => {
    const [rent, food] = barsOf('none')

    expect(food.x).toBeGreaterThan(rent.x)
    expect(rent.y + rent.height).toBeCloseTo(food.y + food.height)
  })

  it('draws stacked columns each on top of the one before', () => {
    const [rent, food] = barsOf('stacked')

    expect(food.x).toBe(rent.x)
    expect(food.y + food.height).toBeCloseTo(rent.y)
    expect(food.height).toBeCloseTo(rent.height * 3)
  })

  it('draws percent-stacked columns to the full height, with percent ticks', () => {
    const { container } = render(<ChartSvg chart={columns('percent')} style={{}} />)
    const ticks = [...container.querySelectorAll('text[text-anchor="end"]')].map(({ textContent }) => textContent)

    expect(ticks).toEqual(['0%', '50%', '100%'])
  })

  it('keeps its scale finite for values at both ends of the double range', () => {
    const [up, down] = barsOf('none', [1e308, -1e308])

    expect([up.y, up.height, down.y, down.height].every(Number.isFinite)).toBe(true)
    expect(up.height).toBeGreaterThan(0)
    expect(down.height).toBeCloseTo(up.height)
  })

  it('stacks values near the largest double without leaving the scale', () => {
    const [first, second] = barsOf('stacked', [1e308, 1e308])

    expect([first.height, second.height].every(Number.isFinite)).toBe(true)
    expect(first.height).toBeGreaterThan(0)
  })
})
