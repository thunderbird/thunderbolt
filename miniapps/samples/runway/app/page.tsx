'use client'

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo } from 'react'
import { useThunderbolt, type ThunderboltTool } from '@thunderbolt/miniapp-sdk'
import { CashChart } from './cash-chart'
import { MoneyInput } from './money-input'
import { usePlanState } from './use-plan-state'
import { useTween } from './use-tween'
import {
  assumptionKeys,
  defaultPlan,
  describeOutcome,
  describePlan,
  formatEuro,
  headline,
  horizon,
  monthLabel,
  parseMonth,
  project,
  summarize,
  type AssumptionKey,
  type Plan,
} from '@/lib/model'

const fields: { key: AssumptionKey; label: string; step: number; money?: boolean }[] = [
  { key: 'startingCash', money: true, label: 'Starting cash (€)', step: 10_000 },
  { key: 'monthlyRevenue', money: true, label: 'Monthly revenue (€)', step: 1_000 },
  { key: 'revenueGrowth', label: 'Monthly growth (%)', step: 0.5 },
  { key: 'baseBurn', money: true, label: 'Base monthly burn (€)', step: 1_000 },
]

/**
 * The Thunderbolt origin to connect to. Unset falls back to the dev server,
 * matching the default in `next.config.ts`: set both when you deploy.
 */
const hostOrigin = process.env.NEXT_PUBLIC_THUNDERBOLT_HOST_ORIGIN

/** Calm at 18+ months of runway (or never running out), amber from 9, red below. */
const runwayTier = (months: number | null) =>
  months === null || months >= 18 ? 'calm' : months >= 9 ? 'warn' : 'danger'

const Page = () => {
  const { plan, selectedMonth, flash, dispatch } = usePlanState()
  const setPlan = (next: Plan, flashKey?: string) => dispatch({ type: 'plan', plan: next, flash: flashKey })

  const rows = useMemo(() => project(plan), [plan])
  const summary = summarize(rows)

  /** Apply a change and return its consequence, which saves the model a round trip. */
  const apply = (next: Plan, what: string, flashKey?: string) => {
    setPlan(next, flashKey)
    return `${what} ${describeOutcome(next)}`
  }

  /**
   * Redefined every render on purpose: `execute` closes over `plan`, and the
   * bridge resolves the tool list per call rather than snapshotting it.
   */
  const tools: ThunderboltTool[] = [
    {
      name: 'set_assumption',
      description:
        'Change one input of the runway plan. Keys: startingCash (€), monthlyRevenue (€, current), revenueGrowth (% per month), baseBurn (€ per month of non-salary costs). Returns the new runway.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: [...assumptionKeys], description: 'Which assumption to change.' },
          value: { type: 'number', description: 'The new value.' },
        },
        required: ['key', 'value'],
      },
      annotations: { readOnlyHint: false, title: 'Change a plan assumption' },
      execute: ({ key, value }: { key: AssumptionKey; value: number }) => {
        if (!assumptionKeys.includes(key)) {
          return `"${key}" is not an assumption in this plan.`
        }
        if (!Number.isFinite(value)) {
          return `"${value}" is not a usable number.`
        }
        return apply({ ...plan, [key]: value }, `Set ${key} to ${value}.`, `field:${key}`)
      },
    },
    {
      name: 'add_hire',
      description:
        'Add a planned hire. startMonth is YYYY-MM within January 2027 to December 2028. Returns the new runway.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          monthlyCost: { type: 'number', description: 'Fully-loaded monthly cost in euros.' },
          startMonth: { type: 'string', description: 'YYYY-MM' },
        },
        required: ['role', 'monthlyCost', 'startMonth'],
      },
      annotations: { readOnlyHint: false, title: 'Add a hire' },
      execute: ({ role, monthlyCost, startMonth }: { role: string; monthlyCost: number; startMonth: string }) => {
        if (parseMonth(startMonth) === null) {
          return `"${startMonth}" is not a YYYY-MM month.`
        }
        if (!Number.isFinite(monthlyCost)) {
          return `"${monthlyCost}" is not a usable cost.`
        }
        return apply(
          { ...plan, hires: [...plan.hires, { role, monthlyCost, startMonth }] },
          `Added ${role} at ${formatEuro(monthlyCost)} a month from ${startMonth}.`,
          `hire:${plan.hires.length}`,
        )
      },
    },
    {
      name: 'remove_hire',
      description:
        'Remove a planned hire by role (case-insensitive) or by zero-based index in the hires list. Returns the new runway.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          index: { type: 'number', description: 'Zero-based position in data.hires.' },
        },
      },
      annotations: { readOnlyHint: false, title: 'Remove a hire' },
      execute: ({ role, index }: { role?: string; index?: number }) => {
        const at = role ? plan.hires.findIndex((hire) => hire.role.toLowerCase() === role.toLowerCase()) : (index ?? -1)
        const hire = plan.hires[at]
        if (!hire) {
          return `No such hire. Current hires: ${plan.hires.map((h) => h.role).join(', ') || 'none'}.`
        }
        return apply({ ...plan, hires: plan.hires.filter((_, i) => i !== at) }, `Removed ${hire.role}.`)
      },
    },
    {
      name: 'add_funding_round',
      description:
        'Add a funding round. month is YYYY-MM within January 2027 to December 2028. Returns the new runway.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          amount: { type: 'number', description: 'Euros received.' },
          month: { type: 'string', description: 'YYYY-MM' },
        },
        required: ['label', 'amount', 'month'],
      },
      annotations: { readOnlyHint: false, title: 'Add a funding round' },
      execute: ({ label, amount, month }: { label: string; amount: number; month: string }) => {
        if (parseMonth(month) === null) {
          return `"${month}" is not a YYYY-MM month.`
        }
        if (!Number.isFinite(amount)) {
          return `"${amount}" is not a usable amount.`
        }
        return apply(
          { ...plan, rounds: [...plan.rounds, { label, amount, month }] },
          `Added ${label}, ${formatEuro(amount)} in ${month}.`,
          `round:${plan.rounds.length}`,
        )
      },
    },
    {
      name: 'remove_funding_round',
      description:
        'Remove a funding round by label (case-insensitive) or by zero-based index in the rounds list. Returns the new runway.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          index: { type: 'number', description: 'Zero-based position in data.rounds.' },
        },
      },
      annotations: { readOnlyHint: false, title: 'Remove a funding round' },
      execute: ({ label, index }: { label?: string; index?: number }) => {
        const at = label
          ? plan.rounds.findIndex((round) => round.label.toLowerCase() === label.toLowerCase())
          : (index ?? -1)
        const round = plan.rounds[at]
        if (!round) {
          return `No such round. Current rounds: ${plan.rounds.map((r) => r.label).join(', ') || 'none'}.`
        }
        return apply({ ...plan, rounds: plan.rounds.filter((_, i) => i !== at) }, `Removed ${round.label}.`)
      },
    },
    {
      name: 'reset_plan',
      description: 'Restore the original plan: default assumptions, hires and funding rounds. Returns the runway.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, title: 'Reset the plan' },
      execute: () => apply(defaultPlan, 'Reset the plan.'),
    },
  ]

  /** Read on demand by `get_app_context`, so there is nothing to publish or keep in sync. */
  const getContext = () => ({
    title: selectedMonth ? `Runway plan: ${selectedMonth}` : 'Runway plan',
    summary: describePlan(plan, rows, selectedMonth),
    data: { plan, summary, months: rows },
    selection: selectedMonth ? rows.find((row) => row.label === selectedMonth) : undefined,
  })

  const { connected, hostContext } = useThunderbolt('Runway Planner', tools, { hostOrigin, getContext })

  // Track the host's appearance so the embedded app doesn't look pasted in.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', hostContext.theme)
  }, [hostContext.theme])

  /** Toggle the focused month, unless the user was highlighting text. */
  const handleSelect = (label: string) => {
    if (!window.getSelection()?.isCollapsed) {
      return
    }
    dispatch({ type: 'select', month: label })
  }

  const updateField = (key: AssumptionKey, raw: string) => {
    const value = Number(raw)
    if (Number.isNaN(value)) {
      return
    }
    setPlan({ ...plan, [key]: value })
  }

  const updateHire = (index: number, patch: Partial<Plan['hires'][number]>) =>
    setPlan({ ...plan, hires: plan.hires.map((hire, i) => (i === index ? { ...hire, ...patch } : hire)) })

  const updateRound = (index: number, patch: Partial<Plan['rounds'][number]>) =>
    setPlan({ ...plan, rounds: plan.rounds.map((round, i) => (i === index ? { ...round, ...patch } : round)) })

  const [animatedRunway] = useTween([summary.runwayMonths ?? horizon])
  const selectedRow = rows.find((row) => row.label === selectedMonth)
  const flashClass = (key: string) => (flash === key ? ' flash' : '')

  return (
    <main className="page" data-tier={runwayTier(summary.runwayMonths)}>
      <div className="header">
        <h1>Lumen Labs runway</h1>
        <span className="status">
          <span className={`dot${connected ? ' live' : ''}`} />
          {connected ? 'Connected to Thunderbolt' : 'Standalone'}
        </span>
      </div>

      <section className="hero" aria-label={headline(summary)}>
        <div className="hero-top">
          <div className="headline" data-tb-select data-tb-label="Runway headline">
            <span className="big">
              {Math.round(animatedRunway)}
              {summary.runwayMonths === null && '+'}
            </span>
            <span className="unit">months of runway</span>
            <span className="when">
              {summary.zeroCashMonth
                ? `Cash runs out in ${summary.zeroCashMonth}`
                : `Cash-positive through ${monthLabel(horizon - 1)}`}
            </span>
          </div>
          <div className="chips">
            <Chip label="Zero-cash month" value={summary.zeroCashMonth ?? 'Not in 24 months'} />
            <Chip label="Revenue covers costs" value={summary.breakEvenMonth ?? 'Not in 24 months'} />
            <Chip label={`Cash at ${monthLabel(horizon - 1)}`} value={formatEuro(summary.endCash)} />
          </div>
        </div>
        <CashChart
          rows={rows}
          rounds={plan.rounds}
          selectedMonth={selectedMonth}
          flash={flash}
          onSelect={handleSelect}
        />
        <p className="hint">
          {selectedRow
            ? `${selectedRow.label}: revenue ${formatEuro(selectedRow.revenue)}, costs ${formatEuro(selectedRow.costs)}, cash ${formatEuro(selectedRow.cash)}`
            : 'Click a month on the chart to focus it.'}
        </p>
      </section>

      <section className="strip">
        {fields.map((field) => (
          <div className={`field${flashClass(`field:${field.key}`)}`} key={field.key}>
            <label htmlFor={field.key}>{field.label}</label>
            {field.money ? (
              <MoneyInput
                id={field.key}
                value={plan[field.key]}
                onValueChange={(value) => setPlan({ ...plan, [field.key]: value })}
              />
            ) : (
              <input
                id={field.key}
                type="number"
                step={field.step}
                value={plan[field.key]}
                onChange={(event) => updateField(field.key, event.target.value)}
              />
            )}
          </div>
        ))}
      </section>

      <section className="group">
        <h2>Planned hires</h2>
        <div className="cards">
          {plan.hires.map((hire, i) => (
            <div
              className={`item${flashClass(`hire:${i}`)}`}
              key={i}
              data-tb-select
              data-tb-label={`Hire: ${hire.role}`}
            >
              <input
                className="title"
                aria-label="Role"
                value={hire.role}
                onChange={(e) => updateHire(i, { role: e.target.value })}
              />
              <div className="sub">
                <MoneyInput
                  aria-label="Monthly cost"
                  value={hire.monthlyCost}
                  onValueChange={(monthlyCost) => updateHire(i, { monthlyCost })}
                />
                <input
                  aria-label="Start month"
                  type="month"
                  value={hire.startMonth}
                  onChange={(e) => updateHire(i, { startMonth: e.target.value })}
                />
              </div>
              <button
                className="remove"
                aria-label={`Remove ${hire.role}`}
                onClick={() => setPlan({ ...plan, hires: plan.hires.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="add"
            onClick={() =>
              setPlan(
                { ...plan, hires: [...plan.hires, { role: 'New hire', monthlyCost: 7_000, startMonth: '2027-06' }] },
                `hire:${plan.hires.length}`,
              )
            }
          >
            + Add hire
          </button>
        </div>
      </section>

      <section className="group">
        <h2>Funding rounds</h2>
        <div className="cards">
          {plan.rounds.map((round, i) => (
            <div
              className={`item${flashClass(`round:${i}`)}`}
              key={i}
              data-tb-select
              data-tb-label={`Round: ${round.label}`}
            >
              <input
                className="title"
                aria-label="Label"
                value={round.label}
                onChange={(e) => updateRound(i, { label: e.target.value })}
              />
              <div className="sub">
                <MoneyInput
                  aria-label="Amount"
                  value={round.amount}
                  onValueChange={(amount) => updateRound(i, { amount })}
                />
                <input
                  aria-label="Month"
                  type="month"
                  value={round.month}
                  onChange={(e) => updateRound(i, { month: e.target.value })}
                />
              </div>
              <button
                className="remove"
                aria-label={`Remove ${round.label}`}
                onClick={() => setPlan({ ...plan, rounds: plan.rounds.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="add"
            onClick={() =>
              setPlan(
                { ...plan, rounds: [...plan.rounds, { label: 'New round', amount: 250_000, month: '2027-10' }] },
                `round:${plan.rounds.length}`,
              )
            }
          >
            + Add round
          </button>
        </div>
      </section>

      <p className="hint">
        {connected
          ? 'Ask the chat a what-if: "What if we hire two more engineers in March?"'
          : 'Open this app inside Thunderbolt to enable the assistant.'}
      </p>
    </main>
  )
}

const Chip = ({ label, value }: { label: string; value: string }) => (
  <div className="chip" data-tb-select data-tb-label={label}>
    <span className="chip-label">{label}</span>
    <span className="chip-value">{value}</span>
  </div>
)

export default Page
