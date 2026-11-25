/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Overlay } from '@/office/xlsx-preview-reader'

type ChartOverlay = Extract<Overlay, { type: 'chart' }>

/** A value kept within what a double holds, so sums of huge values stay finite. */
export const finite = (value: number) => Math.min(Number.MAX_VALUE, Math.max(-Number.MAX_VALUE, value))

/** A bar's span on the value axis: from where it starts to where it ends. */
export type Span = { from: number; to: number }

/**
 * Each series' bars as spans, by series then point. Side by side, a bar runs from zero. Stacked, it starts where the
 * series below it ended, with positive and negative values stacked separately. Percent-stacked, each point is a share
 * of its category.
 */
export const barSpans = ({ series, stacking }: Pick<ChartOverlay, 'series' | 'stacking'>, count: number): Span[][] => {
  if (stacking === 'none') {
    return series.map(({ values }) => values.map((value) => ({ from: 0, to: value })))
  }
  // Summed as shares of the category's largest magnitude, so huge values cannot clamp the total and overflow 100%.
  const totals = Array.from({ length: count }, (_, i) => {
    const largest = series.reduce((most, { values }) => Math.max(most, Math.abs(values[i] ?? 0)), 0) || 1
    return { largest, shares: series.reduce((sum, { values }) => sum + Math.abs(values[i] ?? 0) / largest, 0) || 1 }
  })
  const ends = { up: Array.from({ length: count }, () => 0), down: Array.from({ length: count }, () => 0) }
  return series.map(({ values }) =>
    values.map((raw, i) => {
      const value = stacking === 'percent' ? (raw / totals[i].largest / totals[i].shares) * 100 : raw
      const side = value >= 0 ? ends.up : ends.down
      const from = side[i]
      side[i] = finite(from + value)
      return { from, to: side[i] }
    }),
  )
}
