/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { useFormatters } from '@/i18n/use-formatters'
import type { Overlay } from '@/office/xlsx-preview-reader'
import type { CSSProperties } from 'react'

type ChartOverlay = Extract<Overlay, { type: 'chart' }>

/** Office's default series colours. Not read: series colours from the file. Read `c:spPr` if users need them. */
const palette = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47']

const colorAt = (index: number) => palette[index % palette.length]

/** A value kept within what a double holds, so sums of huge values stay finite. */
const finite = (value: number) => Math.min(Number.MAX_VALUE, Math.max(-Number.MAX_VALUE, value))

const pieSlices = (values: number[], cx: number, cy: number, radius: number) => {
  // As shares of the largest value, so a total of huge values stays finite.
  const largest = values.reduce((most, value) => Math.max(most, value), 0) || 1
  const shares = values.map((value) => Math.max(0, value) / largest)
  const total = shares.reduce((sum, share) => sum + share, 0) || 1
  const angle = { at: -Math.PI / 2 }
  return shares.map((share, i) => {
    const start = angle.at
    const end = start + (share / total) * Math.PI * 2
    angle.at = end
    const large = end - start > Math.PI ? 1 : 0
    const d = `M${cx},${cy} L${cx + radius * Math.cos(start)},${cy + radius * Math.sin(start)} A${radius},${radius} 0 ${large} 1 ${cx + radius * Math.cos(end)},${cy + radius * Math.sin(end)} Z`
    return <path key={i} d={d} fill={colorAt(i)} stroke="#fff" />
  })
}

/** A bar's span on the value axis: from where it starts to where it ends. */
type Span = { from: number; to: number }

/**
 * Each series' bars as spans, by series then point. Side by side, a bar runs from zero. Stacked, it starts where the
 * series below it ended, with positive and negative values stacked separately. Percent-stacked, each point is a share
 * of its category.
 */
const barSpans = ({ series, stacking }: ChartOverlay, count: number): Span[][] => {
  if (stacking === 'none') {
    return series.map(({ values }) => values.map((value) => ({ from: 0, to: value })))
  }
  const totals = Array.from({ length: count }, (_, i) =>
    series.reduce((sum, { values }) => finite(sum + Math.abs(values[i] ?? 0)), 0),
  )
  const ends = { up: Array.from({ length: count }, () => 0), down: Array.from({ length: count }, () => 0) }
  return series.map(({ values }) =>
    values.map((raw, i) => {
      const value = stacking === 'percent' ? (raw / (totals[i] || 1)) * 100 : raw
      const side = value >= 0 ? ends.up : ends.down
      const from = side[i]
      side[i] = finite(from + value)
      return { from, to: side[i] }
    }),
  )
}

/**
 * A bar, column, line, area, pie or doughnut chart drawn as SVG from its series, with bars and columns stacked as the
 * file stacks them. It sits in a layer hidden from assistive technology, and a list beside the grid names each chart
 * instead. Bars are drawn as columns. Labels are SVG text, so text from the file is never parsed as markup, and the
 * axis numbers follow the app's locale.
 */
export const ChartSvg = ({ chart, style }: { chart: ChartOverlay; style: CSSProperties }) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const { width, height, kind, title, series, categories, stacking } = chart
  const pad = { left: 36, right: 8, top: title ? 22 : 8, bottom: 34 }
  const innerWidth = Math.max(1, width - pad.left - pad.right)
  const innerHeight = Math.max(1, height - pad.top - pad.bottom)
  const count = series.reduce((most, s) => Math.max(most, s.values.length), Math.max(1, categories.length))
  const bars = kind === 'column' || kind === 'bar'
  const spans = bars ? barSpans(chart, count) : series.map(({ values }) => values.map((to) => ({ from: 0, to })))
  // Spreading a long series into Math.max throws a RangeError, so these reduce instead.
  const ends = spans.flat().map(({ to }) => to)
  const max = ends.reduce((highest, value) => Math.max(highest, value), 0)
  const min = ends.reduce((lowest, value) => Math.min(lowest, value), 0)
  // Halved before subtracting: 1e308 minus -1e308 is Infinity, which would blank the chart.
  const y = (value: number) => pad.top + innerHeight - ((value / 2 - min / 2) / (max / 2 - min / 2 || 1)) * innerHeight
  const step = innerWidth / count
  const round = kind === 'pie' || kind === 'doughnut'
  // Only the legend entries and category labels that fit are drawn, since a chart can have thousands.
  const legendNames = (round ? categories : series.map((s, i) => s.name || t`Series ${i + 1}`)).slice(
    0,
    Math.max(1, Math.floor((width - pad.left) / 70)),
  )
  const labelEvery = Math.max(1, Math.ceil((count * 30) / innerWidth))
  const tickLabel = (tick: number) =>
    stacking === 'percent' ? formatters.percent(tick / 100) : formatters.number(Math.round(tick * 100) / 100)

  const plot = () => {
    if (round) {
      const cx = width / 2
      const cy = pad.top + innerHeight / 2
      const radius = Math.min(innerWidth, innerHeight) / 2
      return (
        <g>
          {pieSlices(series[0]?.values ?? [], cx, cy, radius)}
          {kind === 'doughnut' && <circle cx={cx} cy={cy} r={radius / 2} fill="#fff" />}
        </g>
      )
    }
    const ticks = [min, min / 2 + max / 2, max]
    const barWidth = stacking === 'none' ? (step * 0.7) / Math.max(1, series.length) : step * 0.7
    return (
      <g>
        <g fontSize={9} fill="#555">
          {ticks.map((tick, i) => (
            <g key={i}>
              <line x1={pad.left} x2={pad.left + innerWidth} y1={y(tick)} y2={y(tick)} stroke="#e5e5e5" />
              <text x={pad.left - 4} y={y(tick) + 3} textAnchor="end">
                {tickLabel(tick)}
              </text>
            </g>
          ))}
          {categories.map(
            (category, i) =>
              i % labelEvery === 0 && (
                <text key={i} x={pad.left + step * (i + 0.5)} y={pad.top + innerHeight + 12} textAnchor="middle">
                  {category}
                </text>
              ),
          )}
        </g>
        {spans.map((points, si) => {
          const color = colorAt(si)
          if (bars) {
            const offset = stacking === 'none' ? barWidth * si : 0
            return points.map(({ from, to }, i) => (
              <rect
                key={`${si}-${i}`}
                x={pad.left + step * i + step * 0.15 + offset}
                y={Math.min(y(from), y(to))}
                width={barWidth}
                height={Math.abs(y(to) - y(from))}
                fill={color}
              />
            ))
          }
          const line = points.map(({ to }, i) => `${pad.left + step * (i + 0.5)},${y(to)}`).join(' ')
          if (kind === 'area') {
            const base = `${pad.left + step * 0.5},${y(0)}`
            const end = `${pad.left + step * (points.length - 0.5)},${y(0)}`
            return <polygon key={si} points={`${base} ${line} ${end}`} fill={color} opacity={0.6} />
          }
          return <polyline key={si} points={line} fill="none" stroke={color} strokeWidth={2} />
        })}
      </g>
    )
  }

  return (
    <svg width={width} height={height} style={{ ...style, background: '#fff', border: '1px solid #d9d9d9' }}>
      {title && (
        <text x={width / 2} y={15} textAnchor="middle" fontSize={12} fontWeight={700} fill="#262626">
          {title}
        </text>
      )}
      {plot()}
      <g fontSize={10} fill="#404040">
        {legendNames.map((name, i) => (
          <g key={i} transform={`translate(${pad.left + i * 70}, ${height - 8})`}>
            <rect width={8} height={8} y={-8} fill={colorAt(i)} />
            <text x={11}>{name}</text>
          </g>
        ))}
      </g>
    </svg>
  )
}
