'use client'

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { formatEuro, formatEuroCompact, horizon, parseMonth, type MonthRow, type Plan } from '@/lib/model'
import { useTween } from './use-tween'

const width = 960
const height = 400
const pad = { top: 44, right: 24, bottom: 64, left: 76 }
const plotHeight = height - pad.top - pad.bottom

type Props = {
  rows: MonthRow[]
  hires: Plan['hires']
  rounds: Plan['rounds']
  selectedMonth: string | null
  flash: string | null
  onSelect: (label: string) => void
}

/** One-line summary of a month: the text the host's Select tool reads from its hit column. */
const describeMonth = (row: MonthRow, hires: Plan['hires'], rounds: Plan['rounds']) => {
  const active = hires.filter((hire) => (parseMonth(hire.startMonth) ?? horizon) <= row.index).length
  const starting = hires.filter((hire) => parseMonth(hire.startMonth) === row.index).map((hire) => hire.role)
  const funded = rounds.filter((round) => parseMonth(round.month) === row.index)
  return [
    `${row.label}: cash ${formatEuro(row.cash)}`,
    `revenue ${formatEuro(row.revenue)}`,
    `costs ${formatEuro(row.costs)}`,
    `${active} planned hires`,
    ...(starting.length ? [`new hire ${starting.join(', ')}`] : []),
    ...funded.map((round) => `${round.label} +${formatEuro(round.amount)}`),
  ].join(', ')
}

const toPath = (points: [number, number][]) =>
  points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px},${py}`).join(' ')

/**
 * Round tick values (1, 2 or 5 times a power of ten) spanning the data, always
 * including 0. The domain snaps to the outer ticks.
 */
const niceScale = (low: number, high: number) => {
  const rough = (high - low || 1) / 4
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)))
  const step = ([1, 2, 5, 10].find((m) => m * magnitude >= rough) ?? 10) * magnitude
  const min = Math.floor(low / step) * step
  const max = Math.ceil(high / step) * step
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => min + i * step)
  return { ticks, min, max }
}

/**
 * Cash balance as an area chart in plain SVG. Points are tweened, so when the
 * chat changes the plan the line morphs instead of jumping. Months after cash
 * runs out are dashed and muted; the row of lights along the bottom is lit
 * while cash is positive.
 */
export const CashChart = ({ rows, hires, rounds, selectedMonth, flash, onSelect }: Props) => {
  const cash = useTween(rows.map((row) => row.cash))
  const zero = rows.find((row) => row.cash < 0)?.index ?? null
  const solidEnd = zero ?? rows.length - 1

  const { ticks, min, max } = niceScale(Math.min(...cash, 0), Math.max(...cash, 0))
  const x = (index: number) => pad.left + (index / (rows.length - 1)) * (width - pad.left - pad.right)
  const y = (value: number) => pad.top + ((max - value) / (max - min)) * plotHeight

  const points = cash.map((value, i): [number, number] => [x(i), y(value)])
  const solid = points.slice(0, solidEnd + 1)
  const step = (width - pad.left - pad.right) / (rows.length - 1)

  const markers = rounds
    .map((round, i) => ({ ...round, i, at: parseMonth(round.month) }))
    .filter((round): round is typeof round & { at: number } => round.at !== null && round.at >= 0 && round.at < horizon)

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart" role="img" aria-label="Cash balance by month">
      <defs>
        <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="area-top" />
          <stop offset="100%" className="area-bottom" />
        </linearGradient>
      </defs>

      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="grid" />
          <text x={pad.left - 10} y={y(tick) + 4} textAnchor="end" className="axis">
            {formatEuroCompact(tick)}
          </text>
        </g>
      ))}

      {zero !== null && (
        <g>
          <rect x={x(zero)} y={pad.top} width={width - pad.right - x(zero)} height={plotHeight} className="zone" />
          <text x={(x(zero) + width - pad.right) / 2} y={pad.top + 18} textAnchor="middle" className="zone-label">
            OUT OF RUNWAY
          </text>
        </g>
      )}

      <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} className="zero" />
      <text x={pad.left + 6} y={y(0) - 6} className="zero-label">
        €0
      </text>

      <path d={`${toPath(solid)} L${x(solidEnd)},${y(0)} L${x(0)},${y(0)} Z`} fill="url(#area-fill)" />
      {zero !== null && <path d={toPath(points.slice(zero))} className="line dashed" />}
      <path d={toPath(solid)} className="line" />

      {markers.map((round) => (
        <g key={round.i} className={`marker${flash === `round:${round.i}` ? ' flash' : ''}`}>
          <line x1={x(round.at)} x2={x(round.at)} y1={pad.top - 6} y2={y(cash[round.at])} className="marker-line" />
          <circle cx={x(round.at)} cy={y(cash[round.at])} r={9} className="marker-ring" />
          <circle cx={x(round.at)} cy={y(cash[round.at])} r={5} className="marker-dot" />
          <text
            x={x(round.at)}
            y={pad.top - 12}
            textAnchor={round.at > 18 ? 'end' : round.at < 3 ? 'start' : 'middle'}
            className="marker-label"
          >
            {round.label} +{formatEuroCompact(round.amount)}
          </text>
        </g>
      ))}

      {rows.map((row) => (
        <g key={row.label}>
          {row.label === selectedMonth && (
            <>
              <line
                x1={x(row.index)}
                x2={x(row.index)}
                y1={pad.top}
                y2={pad.top + plotHeight}
                className="select-line"
              />
              <circle cx={x(row.index)} cy={y(cash[row.index])} r={8} className="select-dot" />
            </>
          )}
          {row.index % 3 === 0 && (
            <text x={x(row.index)} y={height - 40} textAnchor="middle" className="axis">
              {row.label}
            </text>
          )}
          <circle
            cx={x(row.index)}
            cy={height - 16}
            r={5}
            className={`light${row.cash >= 0 ? ' lit' : ''}`}
            style={{ transitionDelay: `${row.index * 18}ms` }}
          />
          <g data-tb-select data-tb-label={row.label}>
            <title>{describeMonth(row, hires, rounds)}</title>
            <rect
              x={x(row.index) - step / 2}
              y={pad.top}
              width={step}
              height={plotHeight}
              className="hit"
              onClick={() => onSelect(row.label)}
            />
          </g>
        </g>
      ))}
    </svg>
  )
}
