/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import type { db } from '@/db/client'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'

/** A database the report can open its read-only transaction on. */
export type UsageReportDatabase = Pick<typeof db, 'transaction'>

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
  /** `hour` is the local start with its UTC offset, e.g. `2026-10-25 01:00 +01:00`. */
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

/** Sum two groups' totals. Distinct users add up because no user is in both groups. */
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
 * Every read shares one read-only snapshot, so a turn recorded mid-report can't
 * land in one breakdown and miss another. The transaction also sets the session
 * time zone, which is what draws the day and hour buckets.
 */
export const getUsageReport = async (
  database: UsageReportDatabase,
  window: UsageReportWindow,
): Promise<UsageReport> => {
  const inWindow = and(gte(inferenceUsage.createdAt, window.from), lt(inferenceUsage.createdAt, window.to))
  const day = sql<string>`to_char(${inferenceUsage.createdAt}, 'YYYY-MM-DD')`
  // Grouped on the instant and labelled with its offset, so the hour a
  // fall-back repeats stays two hours instead of merging into one.
  const hourStart = sql`date_trunc('hour', ${inferenceUsage.createdAt})`
  const hour = sql<string>`to_char(${hourStart}, 'YYYY-MM-DD HH24:00 TZH:TZM')`

  const [byAnonymity, models, days, [peakHour]] = await database.transaction(
    async (tx) => {
      await tx.execute(sql`select set_config('TimeZone', ${window.timeZone}, true)`)
      return Promise.all([
        tx
          .select({ isAnonymous: user.isAnonymous, ...totalsColumns })
          .from(inferenceUsage)
          .innerJoin(user, eq(user.id, inferenceUsage.userId))
          .where(inWindow)
          .groupBy(user.isAnonymous),
        tx
          .select({ provider: inferenceUsage.provider, model: inferenceUsage.model, ...totalsColumns })
          .from(inferenceUsage)
          .where(inWindow)
          .groupBy(inferenceUsage.provider, inferenceUsage.model)
          .orderBy(inferenceUsage.provider, inferenceUsage.model),
        tx
          .select({ day, users: distinctUsers, turns: turnCount, costNanoUsd: costSum })
          .from(inferenceUsage)
          .where(inWindow)
          .groupBy(day)
          .orderBy(day),
        tx
          .select({ hour, users: distinctUsers, turns: turnCount })
          .from(inferenceUsage)
          .where(inWindow)
          .groupBy(hourStart)
          .orderBy(desc(distinctUsers), hourStart)
          .limit(1),
      ])
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )

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

/** One row of the Markdown totals table, under `label`. */
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
