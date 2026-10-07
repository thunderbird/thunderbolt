/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { InferenceDatabase } from './usage-ledger'

export type UsageReportWindow = Readonly<{
  /** Inclusive. */
  from: Date
  /** Exclusive. */
  to: Date
  /** IANA zone the day and hour buckets are drawn in, e.g. `Europe/London`. */
  timeZone: string
}>

export type UsageTotals = Readonly<{
  users: number
  turns: number
  promptTokens: number
  completionTokens: number
  costNanoUsd: bigint
}>

export type UsageReport = Readonly<{
  window: UsageReportWindow
  all: UsageTotals
  anonymous: UsageTotals
  registered: UsageTotals
  models: ReadonlyArray<Readonly<{ provider: string; model: string }> & UsageTotals>
  days: ReadonlyArray<Readonly<{ day: string; users: number; turns: number; costNanoUsd: bigint }>>
  peakHour: Readonly<{ hour: string; users: number; turns: number }> | null
}>

const emptyTotals: UsageTotals = { users: 0, turns: 0, promptTokens: 0, completionTokens: 0, costNanoUsd: 0n }

const distinctUsers = sql<number>`count(distinct ${inferenceUsage.userId})`.mapWith(Number)
const turnCount = sql<number>`count(*)`.mapWith(Number)
const costSum = sql`coalesce(sum(${inferenceUsage.costNanoUsd}), 0)::bigint`.mapWith(inferenceUsage.costNanoUsd)

const totalsColumns = {
  users: distinctUsers,
  turns: turnCount,
  promptTokens: sql<number>`coalesce(sum(${inferenceUsage.promptTokens}), 0)`.mapWith(Number),
  completionTokens: sql<number>`coalesce(sum(${inferenceUsage.completionTokens}), 0)`.mapWith(Number),
  costNanoUsd: costSum,
}

const addTotals = (a: UsageTotals, b: UsageTotals): UsageTotals => ({
  users: a.users + b.users,
  turns: a.turns + b.turns,
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  costNanoUsd: a.costNanoUsd + b.costNanoUsd,
})

/**
 * Adoption and spend for one time window, read from the usage ledger.
 *
 * Counts only: the ledger holds no message content, and no user id leaves this
 * function. A turn is one ledger row, which is one managed model request; for
 * the hosted agent that is one answered message.
 *
 * Ledger rows are deleted with their user (`ON DELETE CASCADE`), so a purge of
 * idle users takes their history with it. Run the report before any purge.
 *
 * Buckets group by position (`group by 1`) because the time zone is a bound
 * parameter, and Postgres won't match the same expression across two placeholders.
 */
export const getUsageReport = async (database: InferenceDatabase, window: UsageReportWindow): Promise<UsageReport> => {
  const inWindow = and(gte(inferenceUsage.createdAt, window.from), lt(inferenceUsage.createdAt, window.to))
  const localTime = sql`${inferenceUsage.createdAt} at time zone ${window.timeZone}`
  const day = sql<string>`to_char(${localTime}, 'YYYY-MM-DD')`
  const hour = sql<string>`to_char(date_trunc('hour', ${localTime}), 'YYYY-MM-DD HH24:00')`

  const [byAnonymity, models, days, [peakHour]] = await Promise.all([
    database
      .select({ isAnonymous: user.isAnonymous, ...totalsColumns })
      .from(inferenceUsage)
      .innerJoin(user, eq(user.id, inferenceUsage.userId))
      .where(inWindow)
      .groupBy(user.isAnonymous),
    database
      .select({ provider: inferenceUsage.provider, model: inferenceUsage.model, ...totalsColumns })
      .from(inferenceUsage)
      .where(inWindow)
      .groupBy(inferenceUsage.provider, inferenceUsage.model)
      .orderBy(inferenceUsage.provider, inferenceUsage.model),
    database
      .select({ day, users: distinctUsers, turns: turnCount, costNanoUsd: costSum })
      .from(inferenceUsage)
      .where(inWindow)
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    database
      .select({ hour, users: distinctUsers, turns: turnCount })
      .from(inferenceUsage)
      .where(inWindow)
      .groupBy(sql`1`)
      .orderBy(sql`count(distinct ${inferenceUsage.userId}) desc`, sql`1`)
      .limit(1),
  ])

  const totalsFor = (isAnonymous: boolean): UsageTotals => {
    const row = byAnonymity.find((candidate) => candidate.isAnonymous === isAnonymous)
    if (!row) {
      return emptyTotals
    }
    const { users, turns, promptTokens, completionTokens, costNanoUsd } = row
    return { users, turns, promptTokens, completionTokens, costNanoUsd }
  }
  const anonymous = totalsFor(true)
  const registered = totalsFor(false)

  return {
    window,
    all: addTotals(anonymous, registered),
    anonymous,
    registered,
    models,
    days,
    peakHour: peakHour ?? null,
  }
}

const integer = new Intl.NumberFormat('en-US')

/** Nano-USD as dollars and cents, e.g. `$1.23`. */
export const formatUsd = (nanoUsd: bigint): string => `$${(Number(nanoUsd / 10_000_000n) / 100).toFixed(2)}`

const formatTotalsRow = (label: string, totals: UsageTotals) =>
  `| ${label} | ${integer.format(totals.users)} | ${integer.format(totals.turns)} | ${integer.format(totals.promptTokens)} | ${integer.format(totals.completionTokens)} | ${formatUsd(totals.costNanoUsd)} |`

/** Render a report as Markdown, ready to paste into a message or document. */
export const formatUsageReport = (report: UsageReport): string => {
  const { from, to, timeZone } = report.window
  const peak = report.peakHour
    ? `Busiest hour: ${report.peakHour.hour}, with ${integer.format(report.peakHour.users)} users and ${integer.format(report.peakHour.turns)} turns.`
    : 'No usage in this window.'

  return [
    '# Usage report',
    '',
    `${from.toISOString()} to ${to.toISOString()}, buckets in ${timeZone}.`,
    '',
    '| | Users | Turns | Input tokens | Output tokens | Spend |',
    '| --- | --: | --: | --: | --: | --: |',
    formatTotalsRow('Anonymous', report.anonymous),
    formatTotalsRow('Registered', report.registered),
    formatTotalsRow('All', report.all),
    '',
    peak,
    '',
    '## By day',
    '',
    '| Day | Users | Turns | Spend |',
    '| --- | --: | --: | --: |',
    ...report.days.map(
      (row) =>
        `| ${row.day} | ${integer.format(row.users)} | ${integer.format(row.turns)} | ${formatUsd(row.costNanoUsd)} |`,
    ),
    '',
    '## By model',
    '',
    '| Provider | Model | Users | Turns | Spend |',
    '| --- | --- | --: | --: | --: |',
    ...report.models.map(
      (row) =>
        `| ${row.provider} | ${row.model} | ${integer.format(row.users)} | ${integer.format(row.turns)} | ${formatUsd(row.costNanoUsd)} |`,
    ),
  ].join('\n')
}
