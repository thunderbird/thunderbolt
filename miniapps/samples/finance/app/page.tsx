'use client'

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react'
import { useThunderbolt, type ThunderboltTool } from '@thunderbolt/miniapp-sdk'
import {
  buildProjection,
  defaultAssumptions,
  describeProjection,
  formatCurrency,
  formatPercent,
  type Assumptions,
} from '@/lib/model'

const fields: { key: keyof Assumptions; label: string; step?: number }[] = [
  { key: 'growthRate', label: 'QoQ growth (%)' },
  { key: 'cogsRate', label: 'COGS (% of revenue)' },
  { key: 'startingHeadcount', label: 'Starting headcount' },
  { key: 'hiresPerQuarter', label: 'Hires per quarter' },
  { key: 'costPerEmployee', label: 'Cost per employee', step: 5_000 },
]

const Page = () => {
  const [assumptions, setAssumptions] = useState<Assumptions>(defaultAssumptions)
  const [selectedQuarter, setSelectedQuarter] = useState<string | null>(null)
  /**
   * Tools the assistant can call in this app.
   *
   * `set_assumption` alone is what makes goal-seek possible: the model changes an
   * input, reads the recomputed model back through `get_app_context`, and
   * iterates. Nothing here implements goal-seek — it falls out of write + read in
   * a loop, which is why one small tool is worth more than a big clever one.
   *
   * Redefined every render on purpose: `execute` closes over `setAssumptions`, and
   * the bridge resolves the tool list per call rather than snapshotting it.
   */
  const tools: ThunderboltTool[] = [
    {
      name: 'set_assumption',
      description:
        'Change one input of the financial model and recompute the projection. Keys: growthRate (QoQ revenue growth, %), cogsRate (% of revenue), startingHeadcount, hiresPerQuarter, costPerEmployee (annual, in dollars). For what-if questions: set it, read the result, adjust.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            enum: ['growthRate', 'cogsRate', 'startingHeadcount', 'hiresPerQuarter', 'costPerEmployee'],
            description: 'Which assumption to change.',
          },
          value: { type: 'number', description: 'The new value.' },
        },
        required: ['key', 'value'],
      },
      // Mutates the user's model, so Thunderbolt prompts before every call.
      annotations: { readOnlyHint: false, title: 'Change a model assumption' },
      execute: ({ key, value }: { key: keyof Assumptions; value: number }) => {
        if (!(key in defaultAssumptions)) {
          return `"${key}" is not an assumption in this model.`
        }
        if (!Number.isFinite(value)) {
          return `"${value}" is not a usable number.`
        }
        setAssumptions((current) => ({ ...current, [key]: value }))
        const updated = { ...assumptions, [key]: value }
        const projection = buildProjection(updated)
        const last = projection[projection.length - 1]
        // Return the consequence, not just an acknowledgement — it saves the model
        // a round trip when it's iterating toward a target.
        return `Set ${key} to ${value}. Q4 operating income is now ${formatCurrency(last.operatingIncome)} at a ${formatPercent(last.margin)} margin.`
      },
    },
  ]

  const { connected, hostContext, sendContext } = useThunderbolt('Finance Model', tools)

  const rows = useMemo(() => buildProjection(assumptions), [assumptions])

  // Track the host's appearance so the embedded app doesn't look pasted in.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', hostContext.theme)
  }, [hostContext.theme])

  /**
   * Publish the model whenever it changes.
   *
   * The host caches the last context it received and serves it to the assistant
   * on demand — there is no pull side to the protocol — so publishing on every
   * meaningful change is the app's half of the contract. Skipped until the
   * handshake completes; `sendContext` is a no-op then anyway, but the effect
   * would run for nothing.
   */
  useEffect(() => {
    if (!connected) {
      return
    }
    sendContext({
      title: selectedQuarter ? `FY26 Projection — ${selectedQuarter}` : 'FY26 Projection',
      summary: describeProjection(assumptions, rows, selectedQuarter),
      data: { assumptions, quarters: rows },
      selection: selectedQuarter ? rows.find((row) => row.quarter === selectedQuarter) : undefined,
    })
  }, [connected, assumptions, rows, selectedQuarter, sendContext])

  /**
   * Toggle the focused quarter — unless the user was highlighting text. Without
   * this, dragging across a row to select a figure also fires the row click on
   * mouseup, so the selection lands and the quarter silently changes underneath it.
   */
  const handleRowClick = (quarter: string) => {
    const hasHighlight = !window.getSelection()?.isCollapsed
    if (hasHighlight) {
      return
    }
    setSelectedQuarter(quarter === selectedQuarter ? null : quarter)
  }

  const updateField = (key: keyof Assumptions, raw: string) => {
    const value = Number(raw)
    if (Number.isNaN(value)) {
      return
    }
    setAssumptions((current) => ({ ...current, [key]: value }))
  }

  return (
    <main className="page">
      <div className="header">
        <h1>FY26 Operating Model</h1>
        <span className="status">
          <span className={`dot${connected ? ' live' : ''}`} />
          {connected ? 'Connected to Thunderbolt' : 'Standalone'}
        </span>
      </div>
      <p className="subtitle">Four-quarter revenue and headcount projection. Select a quarter to focus it.</p>

      <section className="assumptions">
        {fields.map((field) => (
          <div className="field" key={field.key}>
            <label htmlFor={field.key}>{field.label}</label>
            <input
              id={field.key}
              type="number"
              step={field.step ?? 1}
              value={assumptions[field.key]}
              onChange={(event) => updateField(field.key, event.target.value)}
            />
          </div>
        ))}
      </section>

      <table>
        <thead>
          <tr>
            <th>Quarter</th>
            <th>Revenue</th>
            <th>COGS</th>
            <th>Gross profit</th>
            <th>Headcount</th>
            <th>Payroll</th>
            <th>Operating income</th>
            <th>Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.quarter}
              className={row.quarter === selectedQuarter ? 'selected' : undefined}
              onClick={() => handleRowClick(row.quarter)}
              // Marks this row as a selectable unit for the host's Select tool, so a
              // marquee snaps to whole quarters instead of scraping stray cell text.
              data-tb-select
              data-tb-label={`${row.quarter} projection`}
            >
              <td>{row.quarter}</td>
              <td>{formatCurrency(row.revenue)}</td>
              <td>{formatCurrency(row.cogs)}</td>
              <td>{formatCurrency(row.grossProfit)}</td>
              <td>{row.headcount}</td>
              <td>{formatCurrency(row.payroll)}</td>
              <td className={row.operatingIncome < 0 ? 'negative' : undefined}>
                {formatCurrency(row.operatingIncome)}
              </td>
              <td className={row.margin < 0 ? 'negative' : undefined}>{formatPercent(row.margin)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="notes">
        <h2>Notes</h2>
        <p data-tb-select data-tb-label="Note: margin compression">
          Margin compression through the year is driven by the fixed hiring cadence rather than revenue softness —
          payroll steps up every quarter regardless of how the top line performs, so gross profit growth has to outrun a
          staircase. The Q4 figure assumes the December enterprise renewals close on time; if they slip into Q1 the
          full-year operating income falls by roughly a third.
        </p>
        <p data-tb-select data-tb-label="Note: COGS assumption">
          COGS is held flat as a percentage of revenue, which is optimistic. Historically it has crept up 1–2 points
          whenever headcount grows faster than 10% in a quarter, because delivery work gets absorbed into cost of
          revenue rather than opex.
        </p>
      </section>

      {/*
       * No "discuss this" button here on purpose. Reaching the assistant is the
       * host's affordance — Thunderbolt floats its own Chat button over this app —
       * so a customer app never has to render or style one, and the entry point
       * stays consistent across every Mini App.
       *
       * The `chat/open` method is still part of the protocol (and `openChat` is
       * still exported by the bridge) for apps that want to trigger the assistant
       * from a specific in-app action with a seeded question.
       */}
      <p className="hint">
        {connected
          ? 'Select a quarter, then use the Chat button to ask about it.'
          : 'Open this app inside Thunderbolt to enable the assistant.'}
      </p>
    </main>
  )
}

export default Page
