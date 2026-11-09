/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A 24-month cash runway model for a fictional startup. Plain arithmetic: the
 * point of the demo is the bridge, not the finance.
 */

export type Hire = {
  role: string
  /** Fully-loaded monthly cost in euros. */
  monthlyCost: number
  /** First month the cost applies, `YYYY-MM`. */
  startMonth: string
}

export type FundingRound = {
  label: string
  amount: number
  /** Month the money lands, `YYYY-MM`. */
  month: string
}

export type Plan = {
  startingCash: number
  monthlyRevenue: number
  /** Month-over-month revenue growth, as a percentage. */
  revenueGrowth: number
  /** Non-salary monthly costs. */
  baseBurn: number
  hires: Hire[]
  rounds: FundingRound[]
}

export const assumptionKeys = ['startingCash', 'monthlyRevenue', 'revenueGrowth', 'baseBurn'] as const
export type AssumptionKey = (typeof assumptionKeys)[number]

export const horizon = 24
const startYear = 2027
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const defaultPlan: Plan = {
  startingCash: 500_000,
  monthlyRevenue: 30_000,
  revenueGrowth: 3,
  baseBurn: 52_000,
  hires: [
    { role: 'Senior Engineer', monthlyCost: 9_500, startMonth: '2027-03' },
    { role: 'Product Designer', monthlyCost: 7_000, startMonth: '2027-05' },
    { role: 'Sales Lead', monthlyCost: 8_500, startMonth: '2027-07' },
  ],
  rounds: [{ label: 'Angel top-up', amount: 150_000, month: '2027-09' }],
}

export type MonthRow = {
  index: number
  label: string
  revenue: number
  costs: number
  funding: number
  /** Cash at the end of the month. */
  cash: number
}

/** Label for a month index, e.g. 0 is "Jan 2027". */
export const monthLabel = (index: number): string => `${monthNames[index % 12]} ${startYear + Math.floor(index / 12)}`

/** Month index for a `YYYY-MM` string, or null when it is not a valid month. */
export const parseMonth = (value: string): number | null => {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  if (!match) {
    return null
  }
  const month = Number(match[2])
  return month >= 1 && month <= 12 ? (Number(match[1]) - startYear) * 12 + month - 1 : null
}

/** Project cash month by month. A hire or round dated before the horizon counts from month 0. */
export const project = (plan: Plan): MonthRow[] => {
  const hires = plan.hires.map((hire) => ({ ...hire, at: parseMonth(hire.startMonth) ?? horizon }))
  const rounds = plan.rounds.map((round) => ({ ...round, at: Math.max(parseMonth(round.month) ?? horizon, 0) }))
  let cash = plan.startingCash

  return Array.from({ length: horizon }, (_, index) => {
    const revenue = plan.monthlyRevenue * Math.pow(1 + plan.revenueGrowth / 100, index)
    const salaries = hires.filter((hire) => hire.at <= index).reduce((sum, hire) => sum + hire.monthlyCost, 0)
    const funding = rounds.filter((round) => round.at === index).reduce((sum, round) => sum + round.amount, 0)
    const costs = plan.baseBurn + salaries
    cash += revenue - costs + funding
    return { index, label: monthLabel(index), revenue, costs, funding, cash }
  })
}

export type Summary = {
  /** Whole months of non-negative cash, or null when cash never runs out. */
  runwayMonths: number | null
  zeroCashMonth: string | null
  /** First month revenue covers costs, or null if it never does. */
  breakEvenMonth: string | null
  endCash: number
  totalRevenue: number
  totalCosts: number
  totalFunding: number
}

export const summarize = (rows: MonthRow[]): Summary => {
  const zero = rows.find((row) => row.cash < 0)
  const breakEven = rows.find((row) => row.revenue >= row.costs)
  return {
    runwayMonths: zero ? zero.index : null,
    zeroCashMonth: zero?.label ?? null,
    breakEvenMonth: breakEven?.label ?? null,
    endCash: rows[rows.length - 1].cash,
    totalRevenue: rows.reduce((sum, row) => sum + row.revenue, 0),
    totalCosts: rows.reduce((sum, row) => sum + row.costs, 0),
    totalFunding: rows.reduce((sum, row) => sum + row.funding, 0),
  }
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** The headline claim, e.g. "Runway: 14 months, cash runs out in Mar 2028". */
export const headline = (summary: Summary): string =>
  summary.runwayMonths === null
    ? `Cash-positive through ${monthLabel(horizon - 1)}`
    : `Runway: ${plural(summary.runwayMonths, 'month')}, cash runs out in ${summary.zeroCashMonth}`

export const formatEuro = (value: number): string =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value)

/** Short axis form: €1.2M, €350K. */
export const formatEuroCompact = (value: number): string =>
  new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)

/** The consequence of a plan in one sentence, for tool results. */
export const describeOutcome = (plan: Plan): string => {
  const summary = summarize(project(plan))
  const breakEven = summary.breakEvenMonth
    ? `Revenue covers costs from ${summary.breakEvenMonth}.`
    : 'Revenue never covers costs.'
  return `${headline(summary)}. ${breakEven}`
}

/**
 * Prose describing the plan for a language model to read. The structured data
 * rides along separately in `context.data`; this is the part that says what
 * matters.
 */
export const describePlan = (plan: Plan, rows: MonthRow[], selectedMonth: string | null): string => {
  const summary = summarize(rows)
  const lines = [
    `A 24-month cash runway plan for a fictional startup, January 2027 to December 2028, in euros. ${headline(summary)}.`,
    summary.breakEvenMonth
      ? `Revenue first covers costs in ${summary.breakEvenMonth}.`
      : 'Revenue never covers costs in this window.',
    `Over 24 months: revenue ${formatEuro(summary.totalRevenue)}, costs ${formatEuro(summary.totalCosts)}, funding ${formatEuro(summary.totalFunding)}, ending cash ${formatEuro(summary.endCash)}.`,
    `Assumptions: ${formatEuro(plan.startingCash)} starting cash, ${formatEuro(plan.monthlyRevenue)} monthly revenue growing ${plan.revenueGrowth}% a month, ${formatEuro(plan.baseBurn)} base monthly burn, ${plural(plan.hires.length, 'planned hire')}, ${plural(plan.rounds.length, 'funding round')}.`,
  ]
  const row = rows.find((r) => r.label === selectedMonth)
  if (row) {
    lines.push(
      `The user has ${row.label} selected: revenue ${formatEuro(row.revenue)}, costs ${formatEuro(row.costs)}, funding ${formatEuro(row.funding)}, cash at month end ${formatEuro(row.cash)}.`,
    )
  }
  return lines.join(' ')
}
