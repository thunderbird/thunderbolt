/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A small quarterly P&L model. Deliberately plain arithmetic — the point of the
 * demo is the bridge, not the finance.
 */

export type Assumptions = {
  /** Quarter-over-quarter revenue growth, as a percentage. */
  growthRate: number
  /** Cost of goods sold, as a percentage of revenue. */
  cogsRate: number
  /** Headcount at the start of the year. */
  startingHeadcount: number
  /** New hires added each quarter. */
  hiresPerQuarter: number
  /** Fully-loaded annual cost per employee. */
  costPerEmployee: number
}

export const defaultAssumptions: Assumptions = {
  growthRate: 12,
  cogsRate: 38,
  startingHeadcount: 42,
  hiresPerQuarter: 5,
  costPerEmployee: 165_000,
}

const startingRevenue = 3_200_000

export type QuarterRow = {
  quarter: string
  revenue: number
  cogs: number
  grossProfit: number
  headcount: number
  payroll: number
  operatingIncome: number
  margin: number
}

/** Project four quarters from the assumptions. */
export const buildProjection = (assumptions: Assumptions): QuarterRow[] => {
  const { growthRate, cogsRate, startingHeadcount, hiresPerQuarter, costPerEmployee } = assumptions

  return ['Q1', 'Q2', 'Q3', 'Q4'].map((quarter, index) => {
    const revenue = startingRevenue * Math.pow(1 + growthRate / 100, index)
    const cogs = revenue * (cogsRate / 100)
    const grossProfit = revenue - cogs
    const headcount = startingHeadcount + hiresPerQuarter * index
    const payroll = (headcount * costPerEmployee) / 4
    const operatingIncome = grossProfit - payroll
    return {
      quarter,
      revenue,
      cogs,
      grossProfit,
      headcount,
      payroll,
      operatingIncome,
      margin: revenue === 0 ? 0 : (operatingIncome / revenue) * 100,
    }
  })
}

export const formatCurrency = (value: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)

export const formatPercent = (value: number): string => `${value.toFixed(1)}%`

/**
 * Prose describing the model for a language model to read.
 *
 * Written deliberately rather than dumping JSON: the structured data rides along
 * separately in `context.data`, and this is the part that tells the model what
 * matters and what to notice. Keeping the two separate is why an app author can
 * improve how the assistant answers without changing their data shape.
 */
export const describeProjection = (
  assumptions: Assumptions,
  rows: QuarterRow[],
  selectedQuarter: string | null,
): string => {
  const total = rows.reduce((sum, row) => sum + row.revenue, 0)
  const totalIncome = rows.reduce((sum, row) => sum + row.operatingIncome, 0)
  const last = rows[rows.length - 1]
  const first = rows[0]

  const lines = [
    `A four-quarter P&L projection. Full-year revenue is ${formatCurrency(total)} with operating income of ${formatCurrency(totalIncome)}.`,
    `Assumptions: ${assumptions.growthRate}% quarter-over-quarter revenue growth, COGS at ${assumptions.cogsRate}% of revenue, headcount starting at ${assumptions.startingHeadcount} and growing by ${assumptions.hiresPerQuarter} per quarter at ${formatCurrency(assumptions.costPerEmployee)} fully loaded per head.`,
    `Operating margin moves from ${formatPercent(first.margin)} in Q1 to ${formatPercent(last.margin)} in Q4.`,
  ]

  if (last.margin < first.margin) {
    lines.push(
      'Margin compresses across the year: payroll grows on a fixed per-quarter hiring cadence while revenue compounds off a small base, so headcount cost outruns gross profit.',
    )
  }

  if (selectedQuarter) {
    const row = rows.find((r) => r.quarter === selectedQuarter)
    if (row) {
      lines.push(
        `The user has ${row.quarter} selected: revenue ${formatCurrency(row.revenue)}, gross profit ${formatCurrency(row.grossProfit)}, payroll ${formatCurrency(row.payroll)}, operating income ${formatCurrency(row.operatingIncome)}, margin ${formatPercent(row.margin)}.`,
      )
    }
  }

  return lines.join(' ')
}
